#!/usr/bin/env python3
"""Synthesise the 30s trailer score + SFX locally (numpy only), synced to artifacts/timing.json."""
import json, wave, pathlib, numpy as np
ROOT = pathlib.Path(__file__).resolve().parent.parent
T = json.loads((ROOT/'artifacts'/'timing.json').read_text())
SR = 48000; N = int(T['dur']*SR); rng = np.random.default_rng(3)
t = np.arange(N)/SR
L = np.zeros(N); R = np.zeros(N)

def add(sig, at, pan=0.0, gain=1.0):
    i = int(at*SR); sig = sig[:max(0, N-i)]
    if i >= N: return
    L[i:i+len(sig)] += sig*gain*(1-max(pan,0)); R[i:i+len(sig)] += sig*gain*(1+min(pan,0))
def tt(d): return np.arange(int(d*SR))/SR
def env(d, a, r, curve=2.0):
    x = tt(d); e = np.minimum(x/a, 1)*np.exp(-curve*np.maximum(x-a, 0)/r); return e
def noise(d): return rng.normal(0, 1, int(d*SR))
def lp(x, fc):  # one-pole lowpass (array fc allowed)
    y = np.zeros_like(x); a = np.clip(2*np.pi*fc/SR/(1+2*np.pi*fc/SR), 0, 1)
    a = np.broadcast_to(a, x.shape); s = 0.0
    for i in range(len(x)): s += a[i]*(x[i]-s); y[i] = s
    return y
def hp(x, fc): return x - lp(x, fc)
def boom(d=3.2):
    x = tt(d); f = 28+70*np.exp(-x*6); ph = 2*np.pi*np.cumsum(f)/SR
    b = np.sin(ph)*np.exp(-x*1.3) + 0.5*np.sin(2*ph)*np.exp(-x*4)
    n = lp(noise(d), 900)*np.exp(-x*9)*0.8
    return (b+n)*np.minimum(x/0.003, 1)
def hit(d=0.9, f0=60):
    x = tt(d); f = f0+120*np.exp(-x*30); ph = 2*np.pi*np.cumsum(f)/SR
    return (np.sin(ph)*np.exp(-x*6) + hp(noise(d), 2500)*np.exp(-x*40)*0.35)*np.minimum(x/0.002, 1)
def tick(d=0.25):
    x = tt(d); return hp(noise(d), 4000)*np.exp(-x*60)*0.5
def riser(d, f1=200, f2=7000):
    x = tt(d); fc = f1*(f2/f1)**(x/d); n = lp(noise(d), fc); e = (x/d)**2.2
    sw = np.sin(2*np.pi*np.cumsum(120*(8**(x/d)))/SR)*0.25
    return (n*0.9 + sw)*e
def whoosh(d=0.6):
    x = tt(d); fc = 300+5000*np.sin(np.pi*x/d)**2; return lp(noise(d), fc)*np.sin(np.pi*x/d)**1.5
def revsweep(d):
    x = tt(d); return lp(noise(d), 400+6000*(x/d)**3)*(x/d)**3*0.6
def pad(freqs, d, a=1.5, r=2.5):
    x = tt(d); out = np.zeros_like(x)
    for f in freqs:
        for det in (-0.12, 0, 0.12):
            out += np.sin(2*np.pi*(f+det)*x + rng.uniform(0, 6.28))*0.12
            out += (np.sin(2*np.pi*2*(f+det)*x)*0.04)
    e = np.minimum(x/a, 1)*np.minimum((d-x)/r, 1)
    return out*np.clip(e, 0, 1)

# --- ambient drone (D1/A1 minor), swell across the piece
drone = pad([36.7, 55.0, 73.4], T['dur'], a=3, r=1.2)
swell = np.interp(t, [0, 8.9, 9.0, 9.7, 13, 24, 27.6, 29.0, 30], [0.15, 0.55, 0.0, 0.1, 0.45, 0.8, 1.0, 0.8, 0.0])
L += drone*swell*0.9; R += drone[::-1]*swell*0.9

# --- Act 1: word hits, heartbeat tension, riser into cut
for i, w in enumerate(T['words']):
    add(hit(0.9, 55+i*6), w, gain=0.75+0.07*i); add(tick(), w, pan=(-1)**i*0.4, gain=0.7)
add(whoosh(0.5), T['p2']-0.3, gain=0.35)
for k in range(10):   # heartbeat under p2/p3
    b = T['p2']+0.2+k*0.55
    if b < T['cut']-0.1: add(hit(0.4, 45), b, gain=0.25+0.02*k); add(hit(0.3, 42), b+0.17, gain=0.15+0.015*k)
add(riser(T['cut']-T['p3']+0.2), T['p3']-0.2, gain=0.55)
for k in range(10): add(tick(0.12), T['crack']+k*0.045, pan=(-1)**k*0.6, gain=0.5)
add(hit(0.7, 70), T['crack'], gain=1.0)
# the cut: silence (drone ducked), reverse sweep into boom
add(revsweep(T['boom']-T['cut']-0.05), T['cut']+0.05, gain=0.9)

# --- Act 2: boom + logo shimmer
add(boom(), T['boom'], gain=1.15)
add(hp(noise(2.5), 5000)*np.exp(-tt(2.5)*2.2)*0.18, T['boom'])
add(pad([146.8, 220.0, 293.7, 440.0], 3.6, a=0.6, r=1.5), T['boom'], gain=0.8)
add(whoosh(0.9), 12.55, gain=0.5)

# --- Act 3: module cadence: low pulse + tick + whoosh transition each 1.8s
for i, m in enumerate(T['modules']):
    add(hit(0.7, 52+3*i), m, gain=0.9); add(tick(0.3), m+0.02, pan=(-1)**i*0.5, gain=0.9)
    add(whoosh(0.35), m+1.55, pan=(-1)**i*0.5, gain=0.4)
    for j in (0.9,):  # off-beat ping
        x = tt(0.5); add(np.sin(2*np.pi*(880*(1+0.25*(i%3)))*x)*np.exp(-x*9)*0.07, m+j, pan=(-1)**i*0.3)
add(riser(T['run']-23.0, 300, 9000), 23.0, gain=0.7)

# --- Act 4: slams
add(boom(2.0), T['run'], gain=1.0); add(hit(1.0, 58), T['know'], gain=1.1); add(tick(0.4), T['know'], gain=0.9)
add(whoosh(0.5), T['know']+0.1, gain=0.5)

# --- Act 5: resolution chord + final boom, tail fades with the picture
add(boom(3.5), T['final'], gain=1.2)
add(pad([73.4, 146.8, 220.0, 293.7, 440.0, 587.3], 3.0, a=0.5, r=1.6), T['final'], gain=1.1)
x = tt(2.4); add(np.sin(2*np.pi*1174.7*x)*np.exp(-x*2.2)*0.07, T['final']+0.8, pan=0.3)

# --- simple stereo reverb (decaying noise IR), then master
def reverb(x, wet=0.28, d=1.8):
    ir = rng.normal(0, 1, int(d*SR))*np.exp(-np.arange(int(d*SR))/SR*3.2); ir = lp(ir, 5000)
    n = 1 << (len(x)+len(ir)).bit_length(); y = np.fft.irfft(np.fft.rfft(x, n)*np.fft.rfft(ir, n), n)[:len(x)]
    return x*(1-wet*0.5) + y/np.abs(y).max()*np.abs(x).max()*wet*1.6
L = reverb(L); R = reverb(R)
fade = np.clip((T['dur']-t)/0.9, 0, 1)*np.clip(t/0.4, 0, 1)
L *= fade; R *= fade
pk = max(np.abs(L).max(), np.abs(R).max()); L /= pk; R /= pk
# soft-clip glue + normalise to -1 dBFS
L = np.tanh(L*1.6)/np.tanh(1.6)*0.89; R = np.tanh(R*1.6)/np.tanh(1.6)*0.89
st = (np.stack([L, R], 1)*32767).astype('<i2')
out = ROOT/'assets'/'audio'/'score.wav'; out.parent.mkdir(parents=True, exist_ok=True)
with wave.open(str(out), 'wb') as w: w.setnchannels(2); w.setsampwidth(2); w.setframerate(SR); w.writeframes(st.tobytes())
print('wrote', out)
