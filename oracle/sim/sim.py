"""Synthetic player simulator for the Oracle (PNE-Enhanced).

Vectorised over N sessions, 1 step = 1 second (20 ticks), i.e. the rate at which KubeJS samples.
Latent state: arousal a (continuous) -> stress class, tactic style, action mode (hold/flee/engage).
Observed: the 31-dim telemetry vector the KubeJS sampler would produce.

The simulator is a *hypothesis* about how players behave. Anything a classifier learns here is
evidence that the feature set CAN separate the states if players behave roughly like this, not
evidence that real players do. See README notes in train.py output.
"""
import numpy as np

FEATURES = [
    "speed_h", "accel", "heading_rate", "look_rate", "vy", "health", "dhealth", "food",
    "light", "sky", "depth", "sneak", "sprint", "t_since_dmg", "t_since_sight",
    "n16", "n32", "nearest", "dnearest",
    "held_melee", "held_ranged", "held_tool", "held_block", "held_food", "held_light", "held_other",
    "place30", "enclosure", "torch_rate", "dealt", "night",
]
F = len(FEATURES)
STRESS = ["calm", "uneasy", "tense", "panic"]
TACTIC = ["hiding", "kiting", "turtling", "exploring"]
FE = ["neither", "flee", "engage"]

HIDE, KITE, TURTLE, EXPLORE = 0, 1, 2, 3
SURF, CAVE, BASE = 0, 1, 2
HOLD, FLEE, ENGAGE = 0, 1, 2
STILL, SNEAK, WALK, SPRINT = 0, 1, 2, 3
GAIT_SPEED = np.array([0.0, 1.295, 4.317, 5.612])  # vanilla blocks/s (Minecraft Wiki)

DEFAULT = dict(
    bravery_mu=0.0, bravery_sd=0.6, noise=1.0, rate_mult=0.6, style_conc=2.0,
    style_bias=np.array([1.0, 1.0, 1.0, 1.0]), hostile_speed=3.2, skill_lo=0.3, skill_hi=1.0,
    stress_thr=(0.22, 0.45, 0.70), tau_up=3.0, tau_down=25.0,
)


def _cat(rng, P):
    """Sample one category per row of probability matrix P (N,K)."""
    c = P.cumsum(1)
    c /= c[:, -1:]
    u = rng.random((P.shape[0], 1))
    return (u > c).sum(1)


def _sig(x):
    return 1.0 / (1.0 + np.exp(-x))


class Sim:
    def __init__(self, N, seed=0, **kw):
        self.p = dict(DEFAULT)
        self.p.update(kw)
        p = self.p
        self.N = N
        self.rng = rng = np.random.default_rng(seed)
        self.brave = rng.normal(p["bravery_mu"], p["bravery_sd"], N).clip(-1.5, 1.5)
        self.skill = rng.uniform(p["skill_lo"], p["skill_hi"], N)
        self.style_prior = rng.dirichlet(p["style_bias"] * p["style_conc"], N)
        self.tod = rng.integers(0, 1200, N)          # 20-min MC day at 1 step/s
        self.ctx = rng.integers(0, 3, N)
        self.style = _cat(rng, self.style_prior)
        self.enc = np.zeros(N, bool)
        self.n = np.zeros(N, int)
        self.d = np.full(N, 40.0)
        self.mode = np.zeros(N, int)
        self.hp = np.ones(N)
        self.food = rng.uniform(0.6, 1.0, N)
        self.a = rng.uniform(0.0, 0.2, N)
        self.tsd = np.full(N, 600.0)
        self.tss = np.full(N, 600.0)
        self.y = np.where(self.ctx == CAVE, rng.uniform(-50, 40, N), 68.0)
        self.torch_env = rng.random(N)
        self.encl = np.zeros(N)
        self.held = np.full(N, 6)
        self.prev_speed = np.zeros(N)
        self.prev_near = np.full(N, 32.0)
        self.place_hist = np.zeros((N, 30))
        self.torch_ema = np.zeros(N)
        self.eating = np.zeros(N, int)
        self.deaths = np.zeros(N, int)
        self.t = 0

    def night(self):
        ph = (self.tod % 1200) / 1200.0
        return (ph > 0.54) & (ph < 0.96)

    def step(self, pressure=None, aggro=None):
        """Advance one second. pressure: optional (N,) multiplier on encounter arrival rate."""
        p, rng, N = self.p, self.rng, self.N
        nz = p["noise"]
        night = self.night()
        # 1. context switch
        sw = rng.random(N) < 1 / 150
        P = np.where(night[:, None], [0.25, 0.35, 0.40], [0.45, 0.35, 0.20])
        newc = _cat(rng, P)
        self.ctx = np.where(sw & ~self.enc, newc, self.ctx)
        self.torch_env = np.where(sw, rng.random(N), self.torch_env)
        # 2. style switch (slow)
        sw = rng.random(N) < 1 / 400
        mod = np.ones((N, 4))
        mod[self.ctx == BASE, TURTLE] *= 3
        mod[(self.ctx == CAVE) | night, HIDE] *= 1.5
        mod[(self.ctx == SURF) & ~night, EXPLORE] *= 1.5
        news = _cat(rng, self.style_prior * mod)
        self.style = np.where(sw & ~self.enc, news, self.style)
        st = self.style
        # 3. encounters
        base = np.select([self.ctx == SURF, self.ctx == CAVE], [np.where(night, 1 / 60, 1 / 240), 1 / 80], 1 / 300)
        lam = base * p["rate_mult"] * (1.0 if pressure is None else pressure)
        arrive = (~self.enc) & (rng.random(N) < lam)
        self.n = np.where(arrive, 1 + rng.poisson(1.0 + 0.8 * night), self.n)
        self.d = np.where(arrive, rng.uniform(12, 30, N), self.d)
        self.enc |= arrive
        # 4. action mode
        weapon = (self.held == 0) | (self.held == 1)
        Lf = -1.0 + 3 * (self.a - 0.6) + 3 * (0.4 - self.hp) + 1.0 * (st == HIDE) - 0.8 * ((st == KITE) | (st == TURTLE)) - 0.5 * self.brave + 0.3 * (self.n - 1)
        Le = -0.5 + 1.2 * ((st == KITE) | (st == TURTLE)) + 1.5 * (self.hp - 0.5) - 2 * (self.a - 0.6) + 0.5 * self.brave + 0.8 * weapon - 1.0 * (st == HIDE)
        Pm = np.stack([np.ones(N), np.exp(Lf), np.exp(Le)], 1)
        redo = arrive | (rng.random(N) < 0.3)
        newm = _cat(rng, Pm)
        self.mode = np.where(self.enc, np.where(redo, newm, self.mode), HOLD)
        m = self.mode
        # 5. gait
        G = np.tile(np.array([[.45, .35, .18, .02], [.2, .05, .5, .25], [.6, .05, .3, .05], [.15, .05, .5, .3]])[st], 1).reshape(N, 4)
        G = np.where((self.enc & (m == FLEE))[:, None], [.02, .01, .12, .85], G)
        G = np.where((self.enc & (m == ENGAGE))[:, None], np.where((st == KITE)[:, None], [.05, 0, .35, .6], [.1, .02, .38, .5]), G)
        hold_hide = self.enc & (m == HOLD) & (st == HIDE)
        hold_turt = self.enc & (m == HOLD) & (st == TURTLE)
        G = np.where(hold_hide[:, None], [.6, .4, 0, 0], G)
        G = np.where(hold_turt[:, None], [.8, .05, .15, 0], G)
        panicf = np.clip((self.a - 0.6) / 0.4, 0, 1)
        shift = (0.25 * panicf)[:, None] * np.array([-0.5, -0.5, 0.2, 0.8])
        G = np.where(hold_hide[:, None], G, np.clip(G + shift * (G[:, :2].sum(1, keepdims=True) > 0.05), 0.001, None))
        self.eating = np.where((self.food < 0.7) & ~self.enc & (self.eating == 0) & (rng.random(N) < 0.2), 3, np.maximum(self.eating - 1, 0))
        gait = _cat(rng, G)
        gait = np.where(self.eating > 0, np.minimum(gait, WALK), gait)
        speed = GAIT_SPEED[gait] * rng.uniform(0.8, 1.05, N) + np.abs(rng.normal(0, 0.15 * nz, N)) * (gait > 0)
        # 6. distances / kills / hostile tracking
        kiting = self.enc & (st == KITE) & (m == ENGAGE)
        radial = np.select([m == FLEE, kiting & (self.d < 8), kiting & (self.d > 14), kiting, m == ENGAGE],
                           [0.85 * speed, 0.8 * speed, -0.5 * speed, 0.0, -0.7 * speed], 0.0)
        ag = 1.0 if aggro is None else aggro
        vh = p["hostile_speed"] * rng.uniform(0.7, 1.2, N) * (0.7 + 0.3 * ag)
        walled = self.encl >= 6
        d_new = np.maximum(self.d - vh + radial, np.where(walled, 2.2, 0.8))
        self.d = np.where(self.enc, d_new, self.d)
        light_now = self._light(night, st)
        lose = hold_hide & (gait <= SNEAK) & (light_now < 7) & (self.d > 6) & (rng.random(N) < 0.12)
        lose |= self.enc & walled & (rng.random(N) < 0.04)
        ranged = self.held == 1
        krate = self.skill * np.where(ranged & (self.d < 18) & (m == ENGAGE), 0.18, np.where((self.d < 3) & (m != FLEE), 0.35 * (m == ENGAGE) + 0.1, 0.0))
        kills = rng.binomial(np.maximum(self.n, 0), np.clip(krate, 0, 1)) * self.enc
        hits = (self.enc & (krate > 0) & (rng.random(N) < 0.6)).astype(float)
        dealt = kills * rng.uniform(4, 10, N) + hits * rng.uniform(2, 6, N)
        self.n = np.maximum(self.n - kills, 0)
        end = self.enc & ((self.n == 0) | (self.d > 40) | lose)
        self.enc &= ~end
        self.d = np.where(self.enc, self.d, 40.0)
        # 7. damage, regen, food, death
        close = self.enc & (self.d < 2.5)
        nhit = rng.binomial(np.maximum(self.n, 0), np.clip(np.where(close, 0.25 * ag * np.where(walled, 0.3, 1.0), 0.0), 0, 1))
        dmg = nhit * rng.uniform(2, 5, N) / 20
        envd = (self.ctx == CAVE) & (rng.random(N) < 1 / 900)
        dmg = dmg + envd * rng.uniform(1, 6, N) / 20
        hp_prev = self.hp.copy()
        self.hp = np.clip(self.hp - dmg + (self.food >= 0.9) * 0.0125, 0, 1)
        self.food = np.clip(self.food - (1 / 1200) * (1 + 2 * (gait == SPRINT)) + (self.eating == 1) * 0.45, 0, 1)
        self.tsd = np.where(dmg > 0, 0.0, self.tsd + 1)
        dead = self.hp <= 0
        self.deaths += dead
        # 8. sighting and arousal
        vis = self.enc & (self.d < 24) & (rng.random(N) < np.clip(0.3 + 0.6 * light_now / 15 + 0.3 * (self.d < 8) - 0.25 * (st == HIDE), 0.05, 1))
        self.tss = np.where(vis, 0.0, self.tss + 1)
        threat = np.where(self.enc, 1 - np.exp(-self.n * np.exp(-self.d / 10)), 0.0)
        dark = (1 - light_now / 15) * np.where(self._sky(), 0.5, 1.0)
        low_hp = np.clip((0.5 - self.hp) / 0.5, 0, 1)
        drive = 0.9 * threat + 0.6 * np.exp(-self.tsd / 6) + 0.25 * dark + 0.35 * low_hp + 0.15 * (self.enc & ~vis) + 0.2 * np.exp(-self.tss / 30)
        target = np.clip(drive * (1 - 0.25 * self.brave) + 0.05, 0, 1.1)
        tau = np.where(target > self.a, p["tau_up"], p["tau_down"])
        self.a = np.clip(self.a + (target - self.a) / tau + rng.normal(0, 0.02, N), 0, 1.1)
        # 9. motion descriptors
        moving = gait > STILL
        hsd = 15 + 60 * panicf + 70 * kiting + 25 * (m == FLEE) * self.enc
        heading = np.where(moving, np.abs(rng.normal(0, hsd * nz)), 0.0).clip(0, 180)
        look = np.abs(rng.normal(0, (15 + 90 * self.a) * nz + 20 * self.enc)).clip(0, 180)
        cave_exp = (self.ctx == CAVE) & (st == EXPLORE)
        vy = rng.normal(0, np.where(cave_exp, 1.2, 0.3)) + (gait == SPRINT) * (rng.random(N) < 0.3) * rng.normal(0, 1.0, N)
        self.y = np.where(self.ctx == CAVE, np.clip(self.y + vy * 0.5, -58, 45), 0.9 * self.y + 0.1 * np.where(self.ctx == BASE, 65, 70))
        # 10. held item
        H = np.array([[.35, .1, .15, .1, .05, .05, .2], [.15, .55, .1, .1, .02, .03, .05],
                      [.15, .05, .1, .45, .02, .18, .05], [.12, .05, .5, .15, .03, .1, .05]])[st]
        H = np.where((self.enc & (m == ENGAGE))[:, None], np.where((st == KITE)[:, None], [.2, .75, 0, .05, 0, 0, 0], [.8, .1, .05, .05, 0, 0, 0]), H)
        H = np.where((self.enc & (m == FLEE))[:, None], [.4, .1, .2, .2, .02, .03, .05], H)
        H = np.where(hold_turt[:, None], [.3, .1, 0, .5, 0, .1, 0], H)
        H = np.where(hold_hide[:, None], [.6, .1, .1, .05, 0, 0, .15], H)
        chg = rng.random(N) < np.where(self.enc, 0.5, 0.25)
        self.held = np.where(chg, _cat(rng, H + 1e-6), self.held)
        self.held = np.where(self.eating > 0, 4, self.held)
        # 11. placements, torches, enclosure
        prate = np.select([st == TURTLE, st == EXPLORE], [np.where(self.enc, 0.9, 0.08), np.where(self.ctx == CAVE, 0.06, 0.03)], 0.01)
        places = rng.poisson(prate)
        tfrac = np.select([st == TURTLE, (st == EXPLORE) & (self.ctx == CAVE), st == HIDE], [np.where((self.ctx == CAVE) | night, 0.4, 0.2), 0.5, 0.02], 0.1)
        torches = rng.binomial(places, tfrac)
        self.held = np.where(torches > 0, 5, np.where(places > 0, 3, self.held))
        self.place_hist = np.roll(self.place_hist, 1, 1)
        self.place_hist[:, 0] = places
        self.torch_ema = 0.95 * self.torch_ema + 0.05 * torches * 60
        self.torch_env = np.clip(self.torch_env + 0.15 * torches - 0.01 * moving, 0, 1)
        encl_base = np.select([self.ctx == BASE, self.ctx == CAVE], [7.0, 4.5], 1.0)
        self.encl = np.clip(np.where(st == TURTLE, self.encl + places * 0.8 - speed * 0.3, 0.8 * self.encl + 0.2 * encl_base) + rng.normal(0, 0.5 * nz, N), 0, 9)
        self.encl = np.where((st == TURTLE) & (self.ctx == BASE), np.maximum(self.encl, 6), self.encl)
        # 12. hostile observations (+ ambient non-engaging hostiles at night on the surface)
        amb = ((self.ctx == SURF) & night & (rng.random(N) < 0.5)) * rng.integers(0, 3, N)
        amb_d = rng.uniform(20, 32, N)
        d2 = self.d + rng.uniform(0, 8, N)
        n_main = np.where(self.enc, self.n, 0)
        n_near = np.where(self.enc, (self.d < 16) * np.minimum(n_main, 1) + (d2 < 16) * np.maximum(n_main - 1, 0), 0)
        n32 = np.where(self.enc & (self.d < 32), n_main, 0) + amb
        nearest = np.minimum(np.where(self.enc, self.d, 99.0), np.where(amb > 0, amb_d, 99.0))
        nearest = np.minimum(nearest + rng.normal(0, 0.3 * nz, N), 32)
        dnear = nearest - self.prev_near
        self.prev_near = nearest
        # 13. assemble features
        x = np.zeros((N, F))
        x[:, 0] = np.clip(speed / 5.6, 0, 2)
        x[:, 1] = np.abs(speed - self.prev_speed) / 5.6
        x[:, 2] = heading / 180
        x[:, 3] = look / 180
        x[:, 4] = np.clip(vy / 4, -2, 2)
        x[:, 5] = self.hp
        x[:, 6] = np.clip(self.hp - hp_prev, -1, 1)
        x[:, 7] = self.food
        x[:, 8] = light_now / 15
        x[:, 9] = self._sky()
        x[:, 10] = np.clip((63 - self.y) / 64, -0.5, 2)
        x[:, 11] = gait == SNEAK
        x[:, 12] = gait == SPRINT
        x[:, 13] = np.minimum(np.log1p(self.tsd) / np.log1p(600), 1)
        x[:, 14] = np.minimum(np.log1p(self.tss) / np.log1p(600), 1)
        x[:, 15] = np.minimum(n_near / 8, 1)
        x[:, 16] = np.minimum(n32 / 16, 1)
        x[:, 17] = nearest / 32
        x[:, 18] = np.clip(dnear / 8, -1, 1)
        x[np.arange(N), 19 + self.held] = 1
        x[:, 26] = np.minimum(self.place_hist.sum(1) / 10, 1)
        x[:, 27] = self.encl / 9
        x[:, 28] = np.minimum(self.torch_ema / 6, 1)
        x[:, 29] = np.minimum(dealt / 10, 1)
        x[:, 30] = night
        self.prev_speed = speed
        stress = np.digitize(self.a, p["stress_thr"])
        mode_obs = np.where(self.enc, self.mode, HOLD)
        # respawn after death (after recording this second)
        if dead.any():
            self.hp[dead] = 1.0
            self.food[dead] = 1.0
            self.enc[dead] = False
            self.n[dead] = 0
            self.d[dead] = 40.0
            self.a[dead] = 0.4
            self.tsd[dead] = 600
            self.ctx[dead] = BASE
        self.tod += 1
        self.t += 1
        return x, stress, self.style.copy(), mode_obs, dead

    def _sky(self):
        return (self.ctx == SURF)

    def _light(self, night, st):
        surf = np.where(night, np.maximum(4, self.torch_env * 10), 15 - 3 * (self.torch_env < 0.2))
        cave = self.torch_env * 12
        base = 11 + 3 * self.torch_env
        L = np.select([self.ctx == SURF, self.ctx == CAVE], [surf, cave], base)
        L = L - 3 * (self.style == HIDE) + self.rng.normal(0, 0.7, self.N)
        return np.clip(np.round(L), 0, 15)


def generate(N, T, seed=0, horizon=5, **kw):
    """Returns X (N,T,F) float32, stress (N,T), tactic (N,T), mode (N,T), fe label (N,T), deaths."""
    sim = Sim(N, seed, **kw)
    X = np.zeros((N, T + horizon, F), np.float32)
    S = np.zeros((N, T + horizon), np.int8)
    K = np.zeros((N, T + horizon), np.int8)
    M = np.zeros((N, T + horizon), np.int8)
    for t in range(T + horizon):
        x, s, k, m, _ = sim.step()
        X[:, t], S[:, t], K[:, t], M[:, t] = x, s, k, m
    FEL = future_label(M, horizon)
    return X[:, :T], S[:, :T], K[:, :T], M[:, :T], FEL[:, :T], sim.deaths


def future_label(M, horizon):
    """flee if any flee in (t, t+h], else engage if any engage, else neither."""
    N, T = M.shape
    out = np.zeros_like(M)
    for t in range(T):
        fut = M[:, t + 1:t + 1 + horizon]
        if fut.shape[1] == 0:
            continue
        out[:, t] = np.where((fut == FLEE).any(1), FLEE, np.where((fut == ENGAGE).any(1), ENGAGE, 0))
    return out
