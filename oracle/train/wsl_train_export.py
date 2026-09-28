"""WSL2 Ubuntu 24.04 training and export pipeline for the Oracle (TDD 4.2 stages S1-S6). NOT RUN in M5: it needs
the M6 downloads (TensorFlow in WSL, the Edge TPU compiler), which wait for the user's approval (TDD 6.5).

Environment (proposed, TDD 4.2 S2):
    uv venv -p 3.11 ~/oracle-venv && uv pip install tensorflow-cpu==2.15.1 numpy==1.26.4
Run from the repo root inside WSL:
    python oracle/train/wsl_train_export.py --out out/
Then, in the separate py3.9 venv with tflite_runtime 2.5.0.post1 (S4b):
    python oracle/train/s4b_check.py --out out/
Then on Windows (copy out/ into oracle/models/ first):
    python oracle/train/make_manifest.py --tflite-report oracle/models/tflite_report.json

Stages:
  S1 data     synthetic sessions from oracle/sim/sim.py over >= 3 randomised populations (domain randomisation),
              plus opt-in NDJSON logs if --logs is given; 16 x 31 windows at 1 Hz; split by session
  S2 train    float32 Keras 496-64-32-11, Adam lr 2e-3 with cosine decay, batch 512, 12 epochs, sqrt-inverse-
              frequency class weights, L2 1e-5, checkpoint on the best validation macro-F1, seed 20260927
  S3 export   rebuilt with tf.keras.Input(shape=(496,), batch_size=1) and the weights copied (a dynamic batch does
              not compile for the Edge TPU)
  S4 PTQ      full-integer int8 I/O, 300 representative windows at batch 1, TFLITE_BUILTINS_INT8 only, per-tensor
              dense quantisation (a private converter flag: its presence is asserted, never assumed)
  G1 gate     int8 macro-F1 within 1.0 point of float per head, top-1 agreement >= 97 % per head
  S5 compile  edgetpu_compiler -s -o out oracle_mlp_int8.tflite
  G2-G4 gates one subgraph, 0 CPU operations, 0 B off-chip parameter streaming
  S6 report   tflite_report.json: qparams, dtypes, sha256 of every file, compiler log sha256, data hash, TF version
The same float weights are also saved as oracle_mlp.npz, so the CPU fallback (cpu_np) and the TPU model always
come from one training run.
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, os.path.join(ROOT, "sim"))
sys.path.insert(0, HERE)
from sim import generate, F  # noqa: E402
from nn import macro_f1  # noqa: E402

SEED = 20260927
W = 16
POPULATIONS = [  # TDD 4.2 S1 domain randomisation ranges
    dict(noise=0.8, bravery_mu=0.3, hostile_speed=2.8, tau_down=32.0, style_conc=2.0),
    dict(noise=1.0, bravery_mu=0.0, hostile_speed=3.2, tau_down=25.0, style_conc=1.2),
    dict(noise=1.5, bravery_mu=-0.4, hostile_speed=4.0, tau_down=15.0, style_conc=0.7),
]


def windows(X, labels, stride):
    N, T, _ = X.shape
    ts = np.arange(W - 1, T, stride)
    idx = ts[:, None] + np.arange(-W + 1, 1)[None, :]
    return X[:, idx, :].reshape(-1, W, F), [l[:, ts].reshape(-1).astype(np.int64) for l in labels]


def build_data(sessions, T, seed, stride):
    Xs, ys = [], [[], [], []]
    for k, pop in enumerate(POPULATIONS):
        X, S, K, _M, FE, _D = generate(sessions, T, seed=seed + k, **pop)
        Xw, y = windows(X, [S, K, FE], stride)
        Xs.append(Xw)
        for i in range(3):
            ys[i].append(y[i])
    return np.concatenate(Xs), [np.concatenate(y) for y in ys]


def sha(path):
    return hashlib.sha256(open(path, "rb").read()).hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default="out")
    ap.add_argument("--epochs", type=int, default=12)
    a = ap.parse_args()
    import tensorflow as tf  # only inside WSL (M6)
    os.makedirs(a.out, exist_ok=True)
    tf.keras.utils.set_random_seed(SEED)

    Xtr, ytr = build_data(400, 1800, 11, 5)
    Xva, yva = build_data(80, 1800, 111, 5)
    Xte, yte = build_data(200, 1800, 211, 3)
    mu = Xtr.reshape(-1, F).mean(0).astype(np.float32)
    sd = (Xtr.reshape(-1, F).std(0) + 1e-3).astype(np.float32)
    norm = lambda A: ((A - mu) / sd).reshape(len(A), -1).astype(np.float32)  # noqa: E731
    ntr, nva, nte = norm(Xtr), norm(Xva), norm(Xte)
    data_hash = hashlib.sha256(ntr.tobytes()).hexdigest()

    heads = (4, 4, 3)
    cw = []
    for y, k in zip(ytr, heads):
        c = np.bincount(y, minlength=k).astype(np.float64) + 1
        w = (c.sum() / (k * c)) ** 0.5
        cw.append((w / w[y].mean()).astype(np.float32))

    def build(batch):
        reg = tf.keras.regularizers.l2(1e-5)
        i = tf.keras.Input(shape=(W * F,), batch_size=batch, name="window")
        h = tf.keras.layers.Dense(64, activation="relu", kernel_regularizer=reg)(i)
        h = tf.keras.layers.Dense(32, activation="relu", kernel_regularizer=reg)(h)
        o = tf.keras.layers.Dense(11, name="logits", kernel_regularizer=reg)(h)  # softmax per head on the host
        return tf.keras.Model(i, o)

    def loss(y, z):
        y = tf.cast(y, tf.int32)
        tot = 0.0
        a0 = 0
        for hidx, k in enumerate(heads):
            wts = tf.gather(tf.constant(cw[hidx]), y[:, hidx])
            ce = tf.keras.losses.sparse_categorical_crossentropy(y[:, hidx], z[:, a0:a0 + k], from_logits=True)
            tot += tf.reduce_mean(wts * ce)
            a0 += k
        return tot

    def f1s(model, X, ys):
        z = model.predict(X, batch_size=8192, verbose=0)
        out, a0 = [], 0
        for y, k in zip(ys, heads):
            out.append(macro_f1(y, z[:, a0:a0 + k].argmax(1), k))
            a0 += k
        return out, z

    steps = int(np.ceil(len(ntr) / 512)) * a.epochs
    sched = tf.keras.optimizers.schedules.CosineDecay(2e-3, steps)
    model = build(None)
    model.compile(optimizer=tf.keras.optimizers.Adam(sched), loss=loss)
    Ytr = np.stack(ytr, 1)
    best, best_w = -1.0, None
    for ep in range(a.epochs):
        model.fit(ntr, Ytr, epochs=1, batch_size=512, shuffle=True, verbose=0)
        f, _ = f1s(model, nva, yva)
        print("epoch %d val macro-F1 %s" % (ep, np.round(f, 4).tolist()), flush=True)
        if np.mean(f) > best:
            best, best_w = float(np.mean(f)), model.get_weights()
    model.set_weights(best_w)

    export = build(1)
    export.set_weights(model.get_weights())
    Wk = export.get_weights()  # kernel0, bias0, kernel1, bias1, kernel2, bias2
    np.savez(os.path.join(a.out, "oracle_mlp.npz"), Wk[0], Wk[2], Wk[1], Wk[3], Wk[4], Wk[5], mu=mu, sd=sd)

    def rep():
        idx = np.random.default_rng(0).choice(len(ntr), 300, replace=False)
        for k in idx:
            yield [ntr[k:k + 1]]

    conv = tf.lite.TFLiteConverter.from_keras_model(export)
    open(os.path.join(a.out, "oracle_mlp_float.tflite"), "wb").write(conv.convert())
    conv = tf.lite.TFLiteConverter.from_keras_model(export)
    conv.optimizations = [tf.lite.Optimize.DEFAULT]
    conv.representative_dataset = rep
    conv.target_spec.supported_ops = [tf.lite.OpsSet.TFLITE_BUILTINS_INT8]
    conv.inference_input_type = tf.int8
    conv.inference_output_type = tf.int8
    flag = "_experimental_disable_per_channel_quantization_for_dense_layers"
    if not hasattr(conv, flag):
        raise SystemExit("S4: TFLiteConverter has no %s in TF %s; per-tensor dense quantisation cannot be requested" % (flag, tf.__version__))
    setattr(conv, flag, True)
    int8_path = os.path.join(a.out, "oracle_mlp_int8.tflite")
    open(int8_path, "wb").write(conv.convert())

    it = tf.lite.Interpreter(model_path=int8_path)
    it.allocate_tensors()
    di, do = it.get_input_details()[0], it.get_output_details()[0]
    s_in, zp_in = di["quantization"]
    s_out, zp_out = do["quantization"]
    zq = np.zeros((len(nte), 11), np.float32)
    for n in range(len(nte)):
        q = np.clip(np.round(nte[n:n + 1] / s_in) + zp_in, -128, 127).astype(np.int8)
        it.set_tensor(di["index"], q)
        it.invoke()
        zq[n] = (it.get_tensor(do["index"]).astype(np.float32) - zp_out) * s_out
    ff, zf = f1s(export, nte, yte)
    g1 = {"float_f1": ff, "int8_f1": [], "agreement": []}
    a0 = 0
    for y, k in zip(yte, heads):
        g1["int8_f1"].append(macro_f1(y, zq[:, a0:a0 + k].argmax(1), k))
        g1["agreement"].append(float((zq[:, a0:a0 + k].argmax(1) == zf[:, a0:a0 + k].argmax(1)).mean()))
        a0 += k
    for hidx in range(3):
        assert g1["int8_f1"][hidx] - g1["float_f1"][hidx] >= -0.01, ("G1 F1 delta", g1)
        assert g1["agreement"][hidx] >= 0.97, ("G1 agreement", g1)

    log = subprocess.run(["edgetpu_compiler", "-s", "-o", a.out, int8_path], capture_output=True, text=True).stdout
    log_path = os.path.join(a.out, "oracle_mlp_int8_edgetpu.log")
    open(log_path, "w").write(log)
    assert "Number of Edge TPU subgraphs: 1" in log, "G2 failed:\n" + log
    assert "Number of operations that will run on CPU: 0" in log, "G3 failed:\n" + log
    assert "Off-chip memory used for streaming uncached model parameters: 0.00B" in log, "G4 failed:\n" + log

    report = {
        "tf_version": tf.__version__, "data_hash": data_hash, "g1": g1,
        "int8": {"input_dtype": "int8", "input_scale": float(s_in), "input_zero_point": int(zp_in),
                 "output_dtype": "int8", "output_scale": float(s_out), "output_zero_point": int(zp_out), "op_versions": None,
                 "sha256": sha(int8_path)},
        "edgetpu": {"input_dtype": "int8", "input_scale": float(s_in), "input_zero_point": int(zp_in),
                    "output_dtype": "int8", "output_scale": float(s_out), "output_zero_point": int(zp_out), "op_versions": None,
                    "sha256": sha(os.path.join(a.out, "oracle_mlp_int8_edgetpu.tflite"))},
        "compiler_log_sha256": sha(log_path),
        "note": "op_versions are filled in by s4b_check.py (S4b) before make_manifest.py runs",
    }
    np.save(os.path.join(a.out, "s4b_windows.npy"), nte[:100])
    json.dump(report, open(os.path.join(a.out, "tflite_report.json"), "w"), indent=1)
    print(json.dumps(g1, indent=1))


if __name__ == "__main__":
    main()
