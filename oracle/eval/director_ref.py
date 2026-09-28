"""Reference pacing FSM (the measured prototype tdd/oracle/director.py, v1.0 rules), used only by
oracle/eval/closed_loop.py. The director module's own port (tools/director/director.py, DIRECTOR) is authoritative
for the game; this copy keeps the Oracle closed-loop evaluation reproducible on its own."""
import math

STATES = ['CALM', 'UNEASE', 'DREAD', 'PANIC', 'RELEASE']
CFG = dict(tauUp=2.0, tauDown=6.0, up=[0.25, 0.50, 0.75], down=[0.15, 0.38, 0.60], upHold=[3, 3, 2], downHold=[20, 10, 4],
           minDwell=8, panicMax=45, releaseMin=30, releaseMercy=60, releaseReenter=10, panicWindow=600, panicMaxCount=3,
           mercyHealth=0.30, respawnGrace=120, lowConf=0.45)
PACING = {
    'CALM': dict(spawn=1.25, aggro=1.0, beckon=True, ga=1.0),
    'UNEASE': dict(spawn=1.10, aggro=1.0, beckon=True, ga=1.0),
    'DREAD': dict(spawn=0.80, aggro=1.0, beckon=False, ga=1.0),
    'PANIC': dict(spawn=0.00, aggro=0.9, beckon=False, ga=0.5),
    'RELEASE': dict(spawn=0.20, aggro=0.8, beckon=False, ga=0.0),
}


def new():
    return dict(state='CALM', e=0.0, inState=0, above=0, below=0, t=0, panics=[], releaseLen=30, lastRespawn=-99999, govScale=1.0, deaths=[])


def step(d, inp, C=CFG):
    d['t'] += 1
    d['inState'] += 1
    p = inp['stressP']
    conf = max(p)
    idx = (p[1] + 2 * p[2] + 3 * p[3]) / 3
    if conf < C['lowConf'] and inp.get('teacherStress') is not None:
        w = conf / C['lowConf']
        idx = w * idx + (1 - w) * (inp['teacherStress'] / 3)
    tau = C['tauUp'] if idx > d['e'] else C['tauDown']
    d['e'] = d['e'] + (idx - d['e']) * (1 - math.exp(-1 / tau))
    if inp.get('respawned'):
        d['lastRespawn'] = d['t']
    if inp.get('died'):
        d['deaths'].append(d['t'])
    s = d['state']
    nxt = s
    fe = inp.get('feP')
    hard = (inp['nearest'] < 4 and inp['tSinceDamage'] <= 1) or (fe is not None and fe[1] >= 0.6 and inp['nearest'] < 8)
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
        lvl = {'CALM': 0, 'UNEASE': 1, 'DREAD': 2}[s]
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
            d['releaseLen'] = C['releaseMercy'] if recent >= C['panicMaxCount'] else C['releaseMin']
        d['state'] = nxt
        d['inState'] = 0
        d['above'] = 0
        d['below'] = 0
    while d['panics'] and d['t'] - d['panics'][0] > C['panicWindow']:
        d['panics'].pop(0)
    while d['deaths'] and d['t'] - d['deaths'][0] > 3600:
        d['deaths'].pop(0)
    pace = PACING[d['state']]
    mercy = inp['health'] <= C['mercyHealth']
    grace = (d['t'] - d['lastRespawn']) < C['respawnGrace']
    spawn, aggro = pace['spawn'], pace['aggro']
    if mercy:
        spawn = 0.0
        aggro = min(aggro, 0.8)
    if grace:
        spawn = 0.0
    d['govScale'] = max(0.5, min(1.0, 1.0 - 0.15 * max(0, len(d['deaths']) - 1)))
    spawn *= d['govScale']
    return dict(state=d['state'], e=d['e'], spawn=spawn, aggro=aggro, mercy=mercy, grace=grace)


NO_HYST = dict(CFG, up=[0.25, 0.50, 0.75], down=[0.25, 0.50, 0.75], upHold=[1, 1, 1], downHold=[1, 1, 1], minDwell=0, panicMax=10 ** 9,
               releaseMin=0, releaseMercy=0, releaseReenter=0, tauUp=1e-3, tauDown=1e-3)
