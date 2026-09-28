"""Line-for-line Python port of the pure core of overrides/kubejs/server_scripts/pne_resonance.js: the pacing FSM
(pneResFsmStep), signal fusion (pneResFuse), the audio tier controller (pneResTierStep / pneResTierCap) and the
pacing outputs (pneResPaceOut), combined in pure_step (pneResPureStep).

Ported from the measured prototype (TDD Appendix B, oracle/director.py) with the v1.1 changes: the teacher-rule
blend became the heuristic S_H (TDD 2.5.1), the audio tier comes from theta with arousal only as a ceiling (2.5.4),
respawn grace also caps aggression at 0.8 and zeroes the GA weight (2.5.5 table, contract 3.2), and the hourly
governor takes the hive-death count as an input. The EMA constants are the same literals as in the JS, so Node,
Rhino and Python agree bit for bit (suite director-parity).

Contract 1.5: the pacing table and the hourly governor depend on the difficulty profile (0 Peaceful, 1 Easy, 2 Normal,
3 Hard), an input of the pure step (inp['diff'], default 3). PROFILES holds the pace and gov1h of the core's binding
table PNE_CORE_DIFF (pne_00_core.js); parity.py checks the two tables are equal. Hard is PACING / GOV1H, release 1.4.
"""
import math

STATES = ['CALM', 'UNEASE', 'DREAD', 'PANIC', 'RELEASE']
TIERS = ['QUIET', 'UNEASE', 'DREAD']
FSM = dict(aUp=0.3934693402873666, aDown=0.15351827510938587, up=[0.25, 0.50, 0.75], down=[0.15, 0.38, 0.60],
           upHold=[3, 3, 2], downHold=[20, 10, 4], minDwell=8, panicMax=45, releaseMin=30, releaseLong=60,
           releaseReenter=10, panicWindow=600, panicCount=3, lowConf=0.45, eCeil=0.60)
PACING = {
    'CALM': dict(spawn=1.25, aggro=1.0, beckon=True, ga=1.0),
    'UNEASE': dict(spawn=1.10, aggro=1.0, beckon=True, ga=1.0),
    'DREAD': dict(spawn=0.80, aggro=1.0, beckon=False, ga=1.0),
    'PANIC': dict(spawn=0.00, aggro=0.9, beckon=False, ga=0.5),
    'RELEASE': dict(spawn=0.20, aggro=0.8, beckon=False, ga=0.0),
}
GOV1H = dict(floor=0.50, slope=0.15, free=1)


def _pace(spawn, aggro, beckon, ga):
    return {s: dict(spawn=spawn[i], aggro=aggro[i], beckon=beckon[i], ga=ga[i]) for i, s in enumerate(STATES)}


PROFILES = [
    dict(pace=_pace([0, 0, 0, 0, 0], [0.8] * 5, [False] * 5, [0, 0, 0, 0, 0]), gov1h=dict(floor=1, slope=0, free=0)),
    dict(pace=_pace([1.00, 0.95, 0.65, 0.00, 0.10], [1.0, 1.0, 0.9, 0.9, 0.8], [True, True, False, False, False],
                    [1.0, 1.0, 1.0, 0.5, 0.0]), gov1h=dict(floor=0.40, slope=0.25, free=0)),
    dict(pace=_pace([1.10, 1.00, 0.75, 0.00, 0.15], [1.0, 1.0, 1.0, 0.9, 0.8], [True, True, False, False, False],
                    [1.0, 1.0, 1.0, 0.5, 0.0]), gov1h=dict(floor=0.45, slope=0.20, free=1)),
    dict(pace=PACING, gov1h=GOV1H),
]
TIER_UP = [0.25, 0.50]
TIER_DOWN = [0.15, 0.38]
TIER_UP_HOLD = 3
TIER_DOWN_HOLD = 10


def fsm_new():
    return dict(state='CALM', e=0.0, inState=0, above=0, below=0, t=0, panics=[], releaseLen=30)


def tier_new():
    return dict(tier=0, up=0, dn=0)


def fuse(inp):
    w = 0.0
    if inp['fresh']:
        w = min(1, inp['conf'] / FSM['lowConf'])
    return w * inp['eo'] + (1 - w) * inp['sh']


def hard_trigger(inp):
    return (inp['nearest'] < 4 and inp['tsd'] <= 1) or (inp['pflee'] >= 0.6 and inp['nearest'] < 8)


def fsm_step(d, inp):
    C = FSM
    s = d['state']
    nxt = s
    d['t'] += 1
    d['inState'] += 1
    raw = fuse(inp)
    d['e'] = d['e'] + (raw - d['e']) * (C['aUp'] if raw > d['e'] else C['aDown'])
    hard = hard_trigger(inp)
    if s == 'PANIC':
        d['below'] = d['below'] + 1 if d['e'] < C['down'][2] else 0
        if (d['below'] >= C['downHold'][2] and d['inState'] >= C['minDwell']) or d['inState'] >= C['panicMax']:
            nxt = 'RELEASE'
    elif s == 'RELEASE':
        if hard and d['inState'] >= C['releaseReenter'] and d['e'] >= C['up'][2]:
            nxt = 'PANIC'
        elif d['inState'] >= d['releaseLen'] and d['e'] < C['up'][1]:
            nxt = 'UNEASE' if d['e'] >= C['up'][0] else 'CALM'
    else:
        lvl = 0 if s == 'CALM' else (1 if s == 'UNEASE' else 2)
        d['above'] = d['above'] + 1 if d['e'] >= C['up'][lvl] else 0
        d['below'] = d['below'] + 1 if (lvl > 0 and d['e'] < C['down'][lvl - 1]) else 0
        if hard and lvl >= 1:
            nxt = 'PANIC'
        elif d['above'] >= C['upHold'][lvl] and d['inState'] >= C['minDwell']:
            nxt = STATES[lvl + 1]
        elif lvl > 0 and d['below'] >= C['downHold'][lvl - 1] and d['inState'] >= C['minDwell']:
            nxt = STATES[lvl - 1]
    if nxt != s:
        if nxt == 'PANIC':
            d['panics'].append(d['t'])
            recent = sum(1 for x in d['panics'] if d['t'] - x <= C['panicWindow'])
            d['releaseLen'] = C['releaseLong'] if recent >= C['panicCount'] else C['releaseMin']
        d['state'] = nxt
        d['inState'] = 0
        d['above'] = 0
        d['below'] = 0
    while d['panics'] and d['t'] - d['panics'][0] > C['panicWindow']:
        d['panics'].pop(0)
    return hard


def tier_step(a, theta):
    a['up'] = a['up'] + 1 if (a['tier'] < 2 and theta >= TIER_UP[a['tier']]) else 0
    a['dn'] = a['dn'] + 1 if (a['tier'] > 0 and theta < TIER_DOWN[a['tier'] - 1]) else 0
    if a['up'] >= TIER_UP_HOLD:
        a['tier'] += 1
        a['up'] = 0
    elif a['dn'] >= TIER_DOWN_HOLD:
        a['tier'] -= 1
        a['dn'] = 0
    return a['tier']


def tier_cap(raw, e, state, mercy, grace):
    t = raw
    if e > FSM['eCeil'] and t > 1:
        t = 1
    if state == 'RELEASE':
        t = 0
    if mercy or grace:
        t = 0
    return t


def diff_in(v):
    """pneResDiffIn: the profile id of an input, 3 when absent, invalid or outside 0..3."""
    if v is None:
        return 3
    try:
        n = float(v)
    except (TypeError, ValueError):
        return 3
    return int(math.floor(n)) if 0 <= n <= 3 else 3


def pace_out(state, mercy, grace, deaths1h, P=None):
    """pneResPaceOut: P is a profile row (PROFILES[id]); without one the Hard values of release 1.4 apply."""
    p = P['pace'][state] if P and P.get('pace') else PACING[state]
    g = P['gov1h'] if P and P.get('gov1h') else GOV1H
    spawn, aggro, beckon, ga = p['spawn'], p['aggro'], p['beckon'], p['ga']
    if mercy or grace:
        spawn = 0
        aggro = min(aggro, 0.8)
        beckon = False
        ga = 0
    gov = max(g['floor'], min(1, 1 - g['slope'] * max(0, deaths1h - g['free'])))
    spawn = spawn * gov
    return dict(spawn=spawn, aggro=aggro, beckon=beckon, ga=ga, gov=gov)


def new_state():
    return dict(fsm=fsm_new(), tier=tier_new())


def pure_step(st, inp):
    hard = fsm_step(st['fsm'], inp)
    raw = tier_step(st['tier'], inp['theta'])
    tier = tier_cap(raw, st['fsm']['e'], st['fsm']['state'], inp['mercy'], inp['grace'])
    p = pace_out(st['fsm']['state'], inp['mercy'], inp['grace'], inp['deaths1h'], PROFILES[diff_in(inp.get('diff'))])
    return dict(state=st['fsm']['state'], e=st['fsm']['e'], hard=hard, raw=raw, tier=tier, spawn=p['spawn'],
                aggro=p['aggro'], beckon=p['beckon'], ga=p['ga'], gov=p['gov'])
