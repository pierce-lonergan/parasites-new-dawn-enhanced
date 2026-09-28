"""
tdd_pins.py: numbers copied from docs/TDD.md v1.1 (section named on each line) and IMPLEMENTATION.md section 5.

Two users:
  - verify.py applies the comfort-mode class limits (COMFORT) and the L3/L4 rate and depth caps (L3, L4) from here,
    never from spec/layers.json, so a spec edit cannot relax a TDD comfort rule and still pass;
  - tests/test_tdd_pins.py (suite resonance-tdd-pins) checks that spec/layers.json agrees with every value below,
    including the set of classes that do not ship (NOT_SHIPPED, IMPLEMENTATION.md section 5).
    A deliberate difference must be listed in DEVIATIONS with its reason and the decision it rests on; the test
    fails on any difference that is not listed there and on any listed deviation that no longer exists.

Change a value here only together with the TDD or the contract.
"""

# 2.3.1 global render chain
CHAIN = {
    'fs': 48000,
    'G2_floor_hz': 30.0,
    'G3': {'order': 1, 'hz': 5.0},
    'G4': {'order': 4, 'hz': 28.0, 'single_pass_sosfilt': True},
    'G5': {'order': 8, 'hz': 16000.0},
    'G7_min_fade_s': 0.02,
    'G8_tol_lu': 1.0,
    'G8_iterations': 3,
    'G9': {'ceiling_dbtp': -2.0, 'lookahead_ms': 5.0, 'release_ms': 50.0, 'oversample': 4, 'zero_gr_layers': ['L2', 'L3', 'L4']},
    'G10': {'format': 'OGG', 'subtype': 'VORBIS', 'compression_level': 0.3},
}

# 2.3.2 global caps and 2.6 gates
GATES = {
    'V1': {'fs': 48000, 'format': 'OGG', 'subtype': 'VORBIS'},
    'V3': {'max_dbtp': -1.0, 'max_sample_abs': 0.999},
    'V4': {'below_hz': 20.0, 'max_db': -35.0},
    'V5': {'below_hz': 100.0, 'max_share': 0.6},
    'V6': {'f0_tol_hz': 0.2, 'min_depth': 0.7},
    'V7': {'spacing_tol_hz': 0.2, 'level_tol_db': 1.0, 'rough_min_carrier_hz': 250.0},
    'V8': {'rate_tol_hz': 0.05},
    'V9': {'rate_tol_hz': 0.1, 'min_depth': 0.85},
    'V10': {'band_hz': [300.0, 3400.0], 'tol_db': 1.0},
    'V11': {'edge_s': 0.02, 'min_edge_drop_db': 20.0, 'director_max_s': 10.0},
    'V12': {'max_spread_lu': 3.0},
    'V13': {'static_pcm_max_bytes': 64000000, 'stream_above_s': 10.0, 'max_streams_per_state': 4, 'max_fall_db': 5.0},
    'V15': {'normal': {'max_lu': 10.0, 'window_s': 3.0}, 'comfort': {'max_lu': 6.0, 'window_s': 2.0}},
    'V16': {'band_hz': [2000.0, 3200.0], 'min_db': 6.0},
    'global_mmax_max': -13.0,
    'CE': {'min_rate_hz': 2.0, 'max_depth': 0.5},
}

# 2.3.3 / 2.3.4 / 2.6 reference geometry
REFERENCE = {
    'ambientsounds_bed_median_lufs': -29.0,
    'whisper_geometry': {'vol': 0.55, 'd': 6.03, 'att': 32},
    'tell_geometry': {'vol': 1.0, 'd': 12.0, 'att': 24},
    'director_placement': {'height': 12.0, 'att': 128, 'sprint_bps': 5.6},
}

# IMPLEMENTATION.md section 5 (layer slugs, categories, attenuation) and TDD 2.3.2 (levels and delivery)
LAYERS = {
    'L1': {'slug': 'hollow', 'category': 'ambient', 'att': 128},
    'L2': {'slug': 'undertone', 'category': 'ambient', 'att': 128},
    'L3': {'slug': 'pulse', 'category': 'ambient', 'att': 128},
    'L4': {'slug': 'beat', 'category': 'ambient', 'att': 128},
    'L5': {'slug': 'whisper', 'category': 'voice', 'att': 32},
    'L6': {'slug': 'approach', 'category': 'hostile', 'att': 128},
    'L7': {'slug': 'spike', 'category': 'hostile', 'att': 128},
    'L8': {'slug': 'tell', 'category': 'hostile', 'att': 24},
}

# per class: LUFS-I target, tolerance, M-max cap or M-max - I cap, modes (comfort, normal), duration window
CLASSES = {
    'L1.dry': {'lufs': -30.0, 'tol': 1.0, 'mmax_minus_i_max': 4.0, 'lra': [2.0, 4.0], 'modes': (True, True), 'dur': [6.0, 8.0], 'fade_s': 1.5},
    'L1.dread': {'lufs': -32.0, 'tol': 1.0, 'mmax_minus_i_max': 4.0, 'lra': [2.0, 4.0], 'modes': (True, True), 'dur': [6.0, 8.0], 'fade_s': 1.5},
    'L1.muffled': {'lufs': -36.0, 'tol': 1.0, 'mmax_minus_i_max': 4.0, 'lra': [2.0, 4.0], 'modes': (True, True), 'dur': [6.0, 8.0], 'fade_s': 1.5},
    'L1.bed_dry': {'lufs': -30.0, 'tol': 1.0, 'mmax_minus_i_max': 4.0, 'lra': [2.0, 4.0], 'modes': (True, True), 'dur': [45.0, 90.0], 'fade_s': 4.0},
    'L1.bed_dread': {'lufs': -32.0, 'tol': 1.0, 'mmax_minus_i_max': 4.0, 'lra': [2.0, 4.0], 'modes': (True, True), 'dur': [45.0, 90.0], 'fade_s': 4.0},
    'L1.bed_muffled': {'lufs': -36.0, 'tol': 1.0, 'mmax_minus_i_max': 4.0, 'lra': [2.0, 4.0], 'modes': (True, True), 'dur': [45.0, 90.0], 'fade_s': 4.0},
    'L1.t_dry_dread': {'tol': 1.0, 'modes': (True, True), 'dur': [6.0, 8.0], 'sweep_s': 1.5},
    'L1.t_dread_muffled': {'tol': 1.0, 'modes': (True, True), 'dur': [6.0, 8.0], 'sweep_s': 1.5},
    'L1.t_dry_muffled': {'tol': 1.0, 'modes': (True, True), 'dur': [6.0, 8.0], 'sweep_s': 1.5, 'max_drop_lu': 6.0},   # 2.3.3 L0 (b)
    'L2.a': {'lufs': -32.0, 'tol': 1.0, 'mmax_minus_i_max': 6.0, 'modes': (False, True), 'dur': [8.0, 10.0]},
    'L3.heartbeat': {'lufs': -32.0, 'tol': 1.0, 'mmax_minus_i_max': 6.0, 'modes': (False, True), 'dur_max': 10.0},
    'L3.heartbeat_c': {'lufs': -34.0, 'tol': 1.0, 'mmax_minus_i_max': 6.0, 'modes': (True, False), 'dur_max': 8.0},
    'L3.flutter': {'lufs': -32.0, 'tol': 1.0, 'mmax_minus_i_max': 6.0, 'modes': (False, True), 'dur_max': 10.0},
    'L3.rough': {'lufs': -32.0, 'tol': 1.0, 'mmax_minus_i_max': 6.0, 'modes': (False, True), 'dur_max': 10.0},
    'L4.slow': {'lufs': -34.0, 'tol': 1.0, 'mmax_minus_i_max': 6.0, 'modes': (True, True), 'dur': [8.0, 10.0]},
    'L4.tense': {'lufs': -34.0, 'tol': 1.0, 'mmax_minus_i_max': 6.0, 'modes': (False, True), 'dur': [8.0, 10.0]},
    'L5.amb': {'snr_db': -12.0, 'tol': 1.0, 'mmax_cap': -22.0, 'mmax_minus_i_max': 6.0, 'modes': (True, True), 'count_min': 12},
    'L5.near': {'snr_db': -6.0, 'tol': 1.0, 'mmax_cap': -22.0, 'mmax_minus_i_max': 6.0, 'modes': (True, True), 'count_min': 12},
    'L6.n': {'lufs': -24.0, 'tol': 0.5, 'mmax_cap': -18.0, 'modes': (False, True)},
    'L6.c': {'lufs': -28.0, 'tol': 0.5, 'mmax_cap': -24.0, 'modes': (True, False)},
    'L7.a': {'lufs': -20.0, 'tol': 1.0, 'mmax_cap': -14.0, 'modes': (False, True)},
    'L8.a': {'lufs': -22.0, 'tol': 1.0, 'mmax_cap': -16.0, 'modes': (True, True), 'dur': [0.3, 0.8]},
}

# 2.3.2 synthesis table
L1 = {'pink': 0.6, 'brown': 0.4, 'lp_order': 2, 'lp_hz': {'dry': 6000.0, 'dread': 3500.0, 'muffled': 1500.0},
      'peak_hz': 2500.0, 'peak_db': -4.0, 'peak_q': 0.7, 'lp_walk': 0.3, 'walk_hz': [0.02, 0.05]}
L2 = {'f0_hz': [17.0, 21.0], 'f0_step_hz': 0.5, 'tiers': [{'h': [3, 5], 'db': 0.0}, {'h': [8, 16], 'db': -6.0}, {'h': [21, 42], 'db': -18.0}],
      'amp_law': '1/sqrt(n)', 'breath_hz': 0.1, 'breath_depth': 0.2, 'fade_in_s': 3.0, 'fade_out_s': 4.0}
L3 = {'carrier_hz': 80.0, 'rough_carrier_hz': 300.0, 'noise_db': -6.0, 'm_max': 0.6, 'heartbeat_rate_hz': [1.0, 1.4],
      'lub_dub_s': 0.12, 'dub_db': -3.0, 'flutter_fm_hz': 6.0, 'rough_fm_hz': [30.0, 70.0], 'fade_in_min_s': 2.0, 'fade_out_min_s': 3.0}
L4 = {'f1_hz': [150.0, 400.0], 'slow_delta_hz': [0.5, 1.5], 'tense_delta_hz': [4.0, 7.0], 'harm2_db': -12.0, 'fade_in_s': 3.0, 'fade_out_s': 4.0}
L5 = {'formants': [{'hz': [450.0, 750.0], 'bw': 180.0, 'db': 0.0}, {'hz': [1100.0, 1800.0], 'bw': 260.0, 'db': -3.0},
                   {'hz': [2300.0, 2700.0], 'bw': 340.0, 'db': -7.0}],
      'sibilance': {'band_hz': [4000.0, 8000.0], 'order': 4, 'db': -12.0},
      'syllabic_hz': [3.5, 5.0], 'syllabic_depth': 0.45, 'glide': 0.1, 'bursts': [2, 5], 'burst_s': [0.15, 0.45], 'gap_s': [0.08, 0.25],
      'attack_s': 0.02, 'release_s': 0.08}
L6 = {'noise_hp_hz': 40.0, 'noise_hp_order': 4, 'buzz_hz': 55.0, 'buzz_min_harmonic_hz': 110.0, 'end_fade_s': 0.03,
      'n': {'rise_db': 6.0, 'curve': 'quad', 'T_s': [3.0, 3.5], 'lp_hz': [300.0, 5000.0]},
      'c': {'rise_db': 4.0, 'curve': 'linear_db', 'T_s': [4.0, 4.0], 'lp_hz': [600.0, 3000.0]}}
L7 = {'attack_s': 0.025, 'tau_s': 0.35, 'am_hz': 50.0, 'am_depth': 0.5, 'noise_hp_hz': 60.0, 'noise_hp_order': 2, 'cluster_hz': [200.0, 600.0], 'preload': True}
L8 = {'band_hz': [2000.0, 3200.0], 'band_order': 4, 'clicks': [3, 6], 'click_s': [0.015, 0.04], 'spacing_s': [0.06, 0.14],
      'subtitle': 'Something skitters nearby'}

# 2.3.2 "Comfort rule" column and 2.7: limits verify.py measures on the decoded comfort assets. m_tol is the
# measurement tolerance of the carrier-reference fit (measured +-0.003 on the committed files); rate_tol is V8's.
COMFORT = {
    'pulse.heartbeat_c': {'m_max': 0.3, 'm_tol': 0.01, 'rate_hz': [1.0, 1.4], 'rate_tol': 0.05, 'dur_max_s': 8.0},
    'beat.slow': {'rate_max_hz': 2.0},
}
# 2.3.2 comfort envelope rule: L5 syllabic AM depth 0.45 passes; its measured depth on the decoded file must stay
# <= CE max_depth. The phrase-level burst gating of L5 and the L8 click train are not covered by the TDD's
# statement; they are measured and reported as pending a lead decision (see PENDING_CE), never as passes.
PENDING_CE = {
    'whisper.amb': 'phrase-level burst gating (bursts 150-450 ms, gaps 80-250 ms: TDD 2.3.2 L5 synthesis) reads as an envelope line '
                   'above 2 Hz at depth > 0.5; TDD 2.3.2 says L5 passes, counting only the syllabic AM (depth 0.45), which is measured and binding',
    'whisper.near': 'as whisper.amb',
    'tell.a': 'a 0.4-0.6 s click train (3-6 clicks 60-140 ms apart: TDD 2.3.2 L8); L8 is unchanged in comfort mode for fairness (TDD 2.3.2 '
              'Comfort rule column); no TDD statement exempts it from the envelope rule',
}

# IMPLEMENTATION.md section 5 "Stereo beds ... not shipped" (lead decision 1.3): these classes stay in the spec and render
# and verify into tools/resonance/out/ only ("ship": false). No bed_* OGG, sounds.json entry or catalog event ships.
# The spec's ship-false set must be exactly this one, and every amb (AmbientSounds) class must be in it.
NOT_SHIPPED = {
    'L1.bed_dry': 'stereo AmbientSounds bed: a client-side region cannot follow the pacing state, comfort mode or the ledger (I5); '
                  'the director\'s mono dry/dread/muffled/t_* segments are the L1 bed (lead decision 1.3)',
    'L1.bed_dread': 'as L1.bed_dry',
    'L1.bed_muffled': 'as L1.bed_dry',
}

# Deliberate differences between spec/layers.json and the values above. Each one names the TDD gate that forced it
# and the decision it waits for (lead requests in the M1 report).
DEVIATIONS = {
    'L2.a.compression_level': {'spec': 0.0, 'tdd': 0.3, 'why': 'V4 (-35 dB below 20 Hz) fails at 0.3: libvorbis adds a -34 dB '
                               'sub-20 Hz floor to the peaky L2 stack; 0.0 decodes at -40.8 to -42.1 dB. Pending lead approval of the G10 exception.'},
    'L4.slow.delta_hz': {'spec': [1.34, 1.5], 'tdd': [0.5, 1.5], 'why': 'inside the TDD range, narrowed: with V9 depth >= 0.85 a beat under '
                         'about 1.3 Hz swings the 400 ms momentary loudness by > 6 LU in 2 s (V15 comfort). Pending lead confirmation.'},
    'L8.a.dur': {'spec': [0.4, 0.8], 'tdd': [0.3, 0.8], 'why': 'LUFS-I (V2) needs at least one 400 ms block, so tells last >= 0.4 s.'},
    'L8.a.spacing_s': {'spec': [0.08, 0.14], 'tdd': [0.06, 0.14], 'why': 'inside the TDD range, narrowed: onsets at least one click '
                       'length plus 20 ms apart keep the clicks distinct.'},
    'L8.a.clicks': {'spec': [4, 6], 'tdd': [3, 6], 'why': 'inside the TDD range: 4-6 clicks keep every tell >= 0.4 s (V2).'},
    'L4.slow.harm2': {'spec': 'beating pair', 'tdd': 'single 2f1 partial at -12 dB', 'why': 'a single 2f1 partial caps the envelope depth '
                      'near 0.78, under V9 0.85; the pair (2f1, 2f1 + delta) at -12 dB keeps 0.94-0.99.'},
    'L4.tense.harm2': {'spec': 'beating pair', 'tdd': 'single 2f1 partial at -12 dB', 'why': 'as L4.slow.harm2'},
    'L6_L7.att': {'spec': 128, 'tdd': None, 'why': 'the TDD gives no attenuation_distance for L6 and L7; the director-layer value is used.'},
}
