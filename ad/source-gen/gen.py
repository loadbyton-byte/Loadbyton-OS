#!/usr/bin/env python3
"""Generate the LOAD|BY|TON.store 30s ad (HyperFrames) for 16:9 and 9:16 from one spec."""
import re, sys, json, pathlib, random
from PIL import Image
import numpy as np

ROOT = pathlib.Path(__file__).resolve().parent.parent
ICONS = pathlib.Path('/home/user/Loadbyton-OS/public/brand/icons')

# ---- timing spec shared with audio (seconds) --------------------------------
TIMING = {
  "dur": 30.0,
  "words": [1.0, 1.9, 2.8, 3.7],
  "p2": 5.0, "p3": 7.2, "crack": 8.5, "cut": 9.0, "boom": 9.7,
  "modules": [13.3 + 1.8*i for i in range(6)],
  "run": 24.2, "know": 25.7, "final": 27.6, "end": 30.0,
}
(ROOT/'artifacts'/'timing.json').write_text(json.dumps(TIMING, indent=2))

MODS = [
  ("freight-forwarding", "FREIGHT",    "Enquiry to invoice. One thread."),
  ("road-transport",     "TRANSPORT",  "Dispatch to proof of delivery."),
  ("contract-warehouse-3pl","WAREHOUSE","Every pallet. Every movement. Logged."),
  ("ecommerce-fulfilment","FULFILMENT","Pick. Pack. Ship. Scan-verified."),
  ("courier-last-mile",  "DELIVERY",   "COD cash. Exact. Reconciled."),
  ("finance",            "FINANCE",    "Invoice. Collect. Know the margin."),
]

def icon_inner(name):
    s = (ICONS/f'{name}.svg').read_text()
    inner = re.search(r'<g[^>]*>(.*)</g>', s, re.S).group(1)
    inner = re.sub(r'<path ', '<path pathLength="1" ', inner)
    return inner

def grain(path):
    rng = np.random.default_rng(7)
    a = rng.normal(128, 55, (512, 512)).clip(0, 255).astype('uint8')
    im = Image.merge('LA', (Image.fromarray(a), Image.fromarray(np.full((512,512), 255, 'uint8'))))
    im.save(path)

def build(fmt):
    wide = fmt == 'wide'
    W, H = (1920, 1080) if wide else (1080, 1920)
    big   = 250 if wide else 158
    mid   = 120 if wide else 88
    sub   = 40 if wide else 34
    mono  = 30 if wide else 26
    bar   = 138 if wide else 0
    logo_w = 1240 if wide else 900
    icon  = 300 if wide else 330
    route_y = H - bar - (150 if wide else 330)
    pf = 150 if wide else 128
    run_mt = -int(pf*0.5) if wide else -int(pf)
    know_mt = run_mt
    under_t = int(pf*0.78) if wide else int(pf*1.22)
    nodes_x = [int(150 + i*(W-300)/5) for i in range(6)]
    rnd = random.Random(11)
    dust = "".join(
        f'<i class="dust" style="left:{rnd.randint(0,W)}px;top:{rnd.randint(0,H)}px;width:{rnd.choice([2,3,3,4])}px;height:{rnd.choice([2,3,3,4])}px"></i>'
        for _ in range(46))
    modules_html = ""
    for i, (ic, label, line) in enumerate(MODS):
        st = TIMING["modules"][i]
        if wide:
            lay = f'''<div class="mod-wrap row">
              <svg class="mi" id="mi{i}" viewBox="0 0 24 24" width="{icon}" height="{icon}" fill="none" stroke="#fff" stroke-width="0.6" stroke-linecap="round" stroke-linejoin="round">{icon_inner(ic)}</svg>
              <div class="mtxt"><div class="mnum">0{i+1} / 06</div><div class="mmask"><div class="mlabel" id="ml{i}">{label}</div></div><div class="msub" id="ms{i}">{line}</div></div></div>'''
        else:
            lay = f'''<div class="mod-wrap col">
              <svg class="mi" id="mi{i}" viewBox="0 0 24 24" width="{icon}" height="{icon}" fill="none" stroke="#fff" stroke-width="0.6" stroke-linecap="round" stroke-linejoin="round">{icon_inner(ic)}</svg>
              <div class="mtxt"><div class="mnum">0{i+1} / 06</div><div class="mmask"><div class="mlabel" id="ml{i}">{label}</div></div><div class="msub" id="ms{i}">{line}</div></div></div>'''
        modules_html += f'<section id="mod{i}" class="clip scene" data-start="{st}" data-duration="1.8" data-track-index="{2+i%2}">{lay}</section>\n'
    node_html = "".join(f'<i class="node" id="node{i}" style="left:{x}px;top:{route_y}px"></i>' for i, x in enumerate(nodes_x))
    L, R = nodes_x[0], nodes_x[-1]

    html = f'''<!doctype html>
<html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width={W}, height={H}">
<title>LOAD|BY|TON.store - 30s cinematic ({fmt})</title>
<script src="assets/gsap.min.js"></script>
<style>
@font-face{{font-family:"Geist";src:url("assets/geist.woff2") format("woff2");font-weight:100 900}}
@font-face{{font-family:"JetBrains Mono";src:url("assets/jetbrains-mono.woff2") format("woff2");font-weight:100 800}}
*{{box-sizing:border-box}}
body{{margin:0;background:#000;font-family:"Geist",sans-serif;color:#FFFDF7}}
#root{{position:relative;width:{W}px;height:{H}px;overflow:hidden;background:#000}}
.fill{{position:absolute;inset:0}}
#bg{{background:radial-gradient(ellipse 70% 60% at 50% 50%,#10293a 0%,#07131c 55%,#02060a 100%)}}
.clip{{position:absolute;inset:0}}
.scene{{display:flex;align-items:center;justify-content:center;text-align:center}}
.word{{position:absolute;left:0;right:0;top:50%;margin-top:-{int(big*0.55)}px;font-weight:800;font-size:{big}px;line-height:1;letter-spacing:-0.03em;opacity:0;text-transform:uppercase;will-change:transform}}
.word.red{{color:#E53935}}
.phr{{position:absolute;left:0;right:0;top:50%;font-weight:700;font-size:{mid}px;line-height:1.02;letter-spacing:-0.025em;opacity:0;text-transform:uppercase;padding:0 {70 if wide else 60}px}}
.phr em{{font-style:normal;color:#E53935}}
.phr.l2{{margin-top:-{int(mid*1.1)}px}}
.mono{{font-family:"JetBrains Mono",monospace;letter-spacing:.32em;text-transform:uppercase;font-size:{mono}px;color:#9fb3be}}
#horizon{{position:absolute;left:0;width:{W}px;height:3px;top:{H//2}px;background:linear-gradient(90deg,transparent,#E53935 18%,#ff7a6e 50%,#E53935 82%,transparent);box-shadow:0 0 28px 6px rgba(229,57,53,.55);transform-origin:50% 50%;opacity:0}}
.mod-wrap{{display:flex;align-items:center;justify-content:center;gap:{80 if wide else 40}px;width:100%;padding:0 {120 if wide else 60}px}}
.mod-wrap.col{{flex-direction:column;margin-top:-{140}px}}
.mod-wrap.row{{margin-top:-60px}}
.mtxt{{text-align:{'left' if wide else 'center'}}}
.mnum{{font-family:"JetBrains Mono",monospace;letter-spacing:.3em;font-size:{mono}px;color:#E53935;margin-bottom:18px}}
.mmask{{overflow:hidden;padding:6px 0 14px}}
.mlabel{{font-weight:800;font-size:{200 if wide else 128}px;line-height:1;letter-spacing:-0.035em;will-change:transform}}
.msub{{font-weight:400;font-size:{sub}px;color:#c5d3da;margin-top:14px;letter-spacing:.01em;opacity:0}}
.mi{{filter:drop-shadow(0 0 18px rgba(229,57,53,.45))}}
#routeLayer{{position:absolute;inset:0}}
#route{{position:absolute;left:{L}px;top:{route_y-1}px;width:{R-L}px;height:3px;background:rgba(255,255,255,.14)}}
#routeFill{{position:absolute;left:{L}px;top:{route_y-1}px;width:{R-L}px;height:3px;background:linear-gradient(90deg,#E53935,#ff6b60);box-shadow:0 0 22px 4px rgba(229,57,53,.6);transform-origin:0 50%}}
.node{{position:absolute;width:18px;height:18px;margin:-9px 0 0 -9px;border-radius:50%;background:#0A1A24;border:2px solid #5d7380}}
#under{{position:absolute;height:6px;background:#E53935;box-shadow:0 0 30px 8px rgba(229,57,53,.6);transform-origin:0 50%}}
.logo{{position:absolute;left:50%;top:50%;width:{logo_w}px;margin-left:-{logo_w//2}px;opacity:0;transform-origin:50% 50%}}
.tag{{position:absolute;left:0;right:0;text-align:center;opacity:0}}
.flare{{position:absolute;left:-10%;width:120%;height:{14 if wide else 12}px;top:{H//2-7}px;background:radial-gradient(ellipse 50% 50% at 50% 50%,rgba(210,230,255,.95),rgba(110,160,255,.35) 45%,transparent 75%);mix-blend-mode:screen;opacity:0;filter:blur(2px);transform-origin:50% 50%}}
.flash{{background:#fff;opacity:0;mix-blend-mode:screen}}
.glowred{{background:radial-gradient(circle at 50% 50%,rgba(229,57,53,.55),transparent 62%);opacity:0;mix-blend-mode:screen}}
.dust{{position:absolute;border-radius:50%;background:rgba(190,215,235,.8);opacity:0}}
#grain{{position:absolute;left:-256px;top:-256px;width:{W+512}px;height:{H+512}px;background:url(assets/grain.png);opacity:.16;mix-blend-mode:overlay}}
#vig{{background:radial-gradient(ellipse 85% 80% at 50% 50%,transparent 45%,rgba(0,0,0,.72) 100%)}}
#grade{{background:linear-gradient(180deg,rgba(20,60,90,.18),rgba(0,0,0,0) 40%,rgba(120,30,30,.12));mix-blend-mode:soft-light}}
.lbar{{position:absolute;left:0;width:100%;height:{bar}px;background:#000}}
#cover{{background:#000;opacity:0}}
.ghost{{position:absolute;left:0;right:0;top:50%;opacity:0}}
</style></head>
<body>
<div id="root" data-composition-id="main" data-width="{W}" data-height="{H}" data-duration="{TIMING['dur']}">

  <div id="bg" class="fill clip" data-start="0" data-duration="{TIMING['dur']}" data-track-index="0"></div>
  <div id="glowred" class="fill clip glowred" data-start="0" data-duration="{TIMING['dur']}" data-track-index="1"></div>
  <div id="dusts" class="fill clip" data-start="0" data-duration="{TIMING['dur']}" data-track-index="1">{dust}</div>

  <!-- ACT 1: the noise -->
  <section id="actA" class="clip scene" data-start="0" data-duration="9.1" data-track-index="2">
    <div id="horizon"></div>
    <div class="word" id="w1">Ships.</div>
    <div class="word" id="w2">Trucks.</div>
    <div class="word" id="w3">Parcels.</div>
    <div class="word red" id="w4">Paperwork.</div>
    <div class="phr l2" id="p2a">All moving</div>
    <div class="phr" id="p2b" style="margin-top:{int(mid*0.1)}px">at once.</div>
    <div class="phr l2" id="p3a" style="margin-top:-{int(mid*1.6)}px">Still running it on</div>
    <div class="phr" id="p3b" style="margin-top:-{int(mid*0.35)}px"><em>spreadsheets?</em></div>
    <div class="phr" id="g1" style="margin-top:-{int(mid*0.35)}px;color:#00e5ff;mix-blend-mode:screen">spreadsheets?</div>
    <div class="phr" id="g2" style="margin-top:-{int(mid*0.35)}px;color:#ff1744;mix-blend-mode:screen">spreadsheets?</div>
  </section>

  <!-- ACT 2: the reveal -->
  <section id="actB" class="clip scene" data-start="{TIMING['boom']}" data-duration="3.7" data-track-index="3">
    <img class="logo" id="logoB" src="assets/lbt-store-white.png" alt="LOAD BY TON.store" style="margin-top:-{int(logo_w*0.10)}px">
    <div class="tag mono" id="tagB" style="top:calc(50% + {int(logo_w*0.215)}px)">The operating system for logistics</div>
  </section>

  <!-- ACT 3: the modules + the route -->
{modules_html}
  <div id="routeLayer" class="fill clip" data-start="13.2" data-duration="10.9" data-track-index="5">
    <div id="route"></div><div id="routeFill"></div>{node_html}
  </div>

  <!-- ACT 4: the promise -->
  <section id="actD" class="clip scene" data-start="24.1" data-duration="3.4" data-track-index="2">
    <div class="word" id="run" style="font-size:{pf}px;margin-top:{run_mt}px;padding:0 50px">Run the movement.</div>
    <div class="word" id="know" style="font-size:{pf}px;margin-top:{know_mt}px;padding:0 50px">Know the <span style="color:#E53935">margin.</span></div>
    <div id="under" style="left:{(W-int(W*0.5))//2}px;width:{int(W*0.5)}px;top:calc(50% + {under_t}px)"></div>
  </section>

  <!-- ACT 5: the end card -->
  <section id="actE" class="clip scene" data-start="{TIMING['final']-0.2}" data-duration="{TIMING['dur']-TIMING['final']+0.2}" data-track-index="3">
    <img class="logo" id="logoE" src="assets/lbt-store-white.png" alt="LOAD BY TON.store" style="margin-top:-{int(logo_w*0.08)}px">
    <div class="tag mono" id="tagE" style="top:calc(50% + {int(logo_w*0.225)}px);color:#dfe8ed">Your logistics company, connected.</div>
  </section>

  <!-- persistent cinematic layers -->
  <div id="flare1" class="flare clip" data-start="0" data-duration="{TIMING['dur']}" data-track-index="6"></div>
  <div id="flare2" class="flare clip" data-start="0" data-duration="{TIMING['dur']}" data-track-index="6" style="top:{H//2-3}px;height:5px;background:radial-gradient(ellipse 50% 50% at 50% 50%,rgba(255,150,140,.95),rgba(229,57,53,.3) 45%,transparent 75%)"></div>
  <div id="flash" class="fill clip flash" data-start="0" data-duration="{TIMING['dur']}" data-track-index="7"></div>
  <div id="cover" class="fill clip" data-start="0" data-duration="{TIMING['dur']}" data-track-index="8"></div>
  <div id="grade" class="fill clip" data-start="0" data-duration="{TIMING['dur']}" data-track-index="9"></div>
  <div id="vig" class="fill clip" data-start="0" data-duration="{TIMING['dur']}" data-track-index="10"></div>
  <div id="grainwrap" class="fill clip" data-start="0" data-duration="{TIMING['dur']}" data-track-index="11" style="overflow:hidden"><div id="grain"></div></div>
  {'<div class="lbar clip" id="bt" data-start="0" data-duration="%s" data-track-index="12" style="top:0"></div><div class="lbar clip" id="bb" data-start="0" data-duration="%s" data-track-index="12" style="bottom:0;top:auto"></div>' % (TIMING['dur'], TIMING['dur']) if wide else ''}
</div>

<script>
window.__timelines = window.__timelines || {{}};
const T = {json.dumps(TIMING)};
const tl = gsap.timeline({{paused:true}});
const cx = {W//2}, cy = {H//2};
function rng(seed){{let s=seed;return()=>{{s=(s*1664525+1013904223)%4294967296;return s/4294967296;}}}}
const R = rng(42);

/* ---------- helpers ---------- */
function flare(id, t, strength, dur){{
  tl.fromTo(id,{{scaleX:.15,opacity:0}},{{scaleX:1,opacity:strength,duration:dur*0.18,ease:"power4.out",immediateRender:false}},t);
  tl.to(id,{{opacity:0,duration:dur*0.82,ease:"power2.in"}},t+dur*0.18);
}}
function flash(t, a, dur){{ tl.fromTo("#flash",{{opacity:0}},{{opacity:a,duration:0.04,ease:"none",immediateRender:false}},t); tl.to("#flash",{{opacity:0,duration:dur,ease:"power3.out"}},t+0.04); }}
function slam(id, t, outT, opts){{
  opts = opts||{{}};
  tl.fromTo(id,{{opacity:0,scale:opts.from||1.35,y:opts.y||0}},{{opacity:1,scale:1,y:0,duration:0.16,ease:"power4.out"}},t);
  tl.to(id,{{scale:1.04,duration:outT-t-0.1,ease:"none"}},t+0.16);
  tl.to(id,{{opacity:0,duration:0.08,ease:"none"}},outT-0.08);
}}
function pulseRed(t,a,dur){{ tl.fromTo("#glowred",{{opacity:0}},{{opacity:a,duration:0.08,ease:"power2.out",immediateRender:false}},t); tl.to("#glowred",{{opacity:0,duration:dur,ease:"power2.in"}},t+0.08); }}

/* ---------- ambient: dust drift, grain jitter, slow bg breath ---------- */
document.querySelectorAll(".dust").forEach((d,i)=>{{
  const a=0.12+R()*0.55, dx=(R()-.5)*160, dy=-40-R()*140, t0=R()*8;
  tl.fromTo(d,{{opacity:0,x:0,y:0}},{{opacity:a,duration:1.2,ease:"none"}},t0);
  tl.to(d,{{x:dx,y:dy,duration:24,ease:"none"}},t0);
  tl.to(d,{{opacity:0,duration:1.5,ease:"none"}},Math.min(t0+22,28.4));
}});
for(let f=0; f<T.dur*12; f++){{ tl.set("#grain",{{x:Math.round(R()*220-110),y:Math.round(R()*220-110)}},f/12); }}
tl.fromTo("#bg",{{scale:1.0}},{{scale:1.12,duration:T.dur,ease:"none"}},0);

/* ---------- ACT 1 ---------- */
tl.fromTo("#horizon",{{opacity:0,scaleX:0}},{{opacity:1,scaleX:1,duration:1.5,ease:"power3.inOut"}},0.25);
tl.to("#horizon",{{opacity:0.0,duration:0.5,ease:"power2.in"}},T.words[3]+0.9);
const W_OUT=[T.words[1]-0.02,T.words[2]-0.02,T.words[3]-0.02,4.9];
["#w1","#w2","#w3","#w4"].forEach((id,i)=>{{ slam(id,T.words[i],W_OUT[i],{{from:i==3?1.5:1.35}}); flare(i%2?"#flare2":"#flare1",T.words[i],0.85,0.9); }});
pulseRed(T.words[3],0.55,1.4); flash(T.words[3],0.12,0.25);

tl.fromTo("#p2a",{{opacity:0,y:30}},{{opacity:1,y:0,duration:0.7,ease:"power3.out"}},T.p2);
tl.fromTo("#p2b",{{opacity:0,y:30}},{{opacity:1,y:0,duration:0.7,ease:"power3.out"}},T.p2+0.35);
tl.to(["#p2a","#p2b"],{{scale:1.05,duration:2.0,ease:"none"}},T.p2+0.1);
tl.to(["#p2a","#p2b"],{{opacity:0,duration:0.12,ease:"none"}},T.p3-0.14);

tl.fromTo("#p3a",{{opacity:0,y:24}},{{opacity:1,y:0,duration:0.6,ease:"power3.out"}},T.p3);
tl.fromTo("#p3b",{{opacity:0,scale:1.18}},{{opacity:1,scale:1,duration:0.35,ease:"power4.out"}},T.p3+0.45);
tl.to(["#p3a","#p3b"],{{scale:1.03,duration:1.3,ease:"none"}},T.p3+0.5);
/* glitch crack */
const g0=T.crack; 
for(let k=0;k<10;k++){{
  const t=g0+k*0.045;
  tl.set("#g1",{{opacity:k%3==2?0:0.85,x:(R()-.3)*26,y:(R()-.5)*6}},t);
  tl.set("#g2",{{opacity:k%2?0.8:0,x:-(R()-.3)*26,y:(R()-.5)*6}},t);
  tl.set("#p3b",{{x:(R()-.5)*14,scaleY:k%4==1?0.92:1}},t);
}}
tl.set("#g1",{{opacity:0}},T.cut); tl.set("#g2",{{opacity:0}},T.cut);
flash(g0,0.22,0.3);
/* the cut to black */
tl.set("#cover",{{opacity:1}},T.cut);
tl.set("#cover",{{opacity:0}},T.boom);

/* ---------- ACT 2: reveal ---------- */
flash(T.boom,0.95,0.55); flare("#flare1",T.boom,1,1.6); flare("#flare2",T.boom+0.05,.9,1.4);
pulseRed(T.boom,0.7,1.8);
tl.fromTo("#logoB",{{opacity:0,scale:1.12}},{{opacity:1,scale:1,duration:0.5,ease:"power3.out"}},T.boom+0.04);
tl.to("#logoB",{{scale:1.05,duration:3.4,ease:"none"}},T.boom+0.55);
tl.fromTo("#tagB",{{opacity:0,y:16}},{{opacity:1,y:0,duration:0.8,ease:"power2.out"}},T.boom+1.2);
tl.to(["#logoB","#tagB"],{{opacity:0,duration:0.25,ease:"power2.in"}},13.05);

/* ---------- ACT 3: modules ---------- */
tl.fromTo("#routeFill",{{scaleX:0.0001}},{{scaleX:0.0001,duration:0.01}},13.2);
const nodeX = {json.dumps(nodes_x)};
for(let i=0;i<6;i++){{
  const t=T.modules[i];
  const sec="#mod"+i;
  /* camera push on the whole module */
  tl.fromTo(sec,{{scale:1.0}},{{scale:1.06,duration:1.8,ease:"none"}},t);
  /* icon draw-on */
  tl.fromTo("#mi"+i+" path, #mi"+i+" rect, #mi"+i+" circle",{{strokeDasharray:1,strokeDashoffset:1}},{{strokeDashoffset:0,duration:0.7,ease:"power2.inOut"}},t+0.02);
  tl.fromTo("#mi"+i,{{opacity:0,x:-40}},{{opacity:1,x:0,duration:0.5,ease:"power3.out"}},t+0.02);
  /* masked label rise */
  tl.fromTo("#ml"+i,{{y:{int(200 if wide else 128)*1.1},opacity:1}},{{y:0,duration:0.5,ease:"expo.out"}},t+0.05);
  tl.fromTo("#ms"+i,{{opacity:0,y:14}},{{opacity:1,y:0,duration:0.45,ease:"power2.out"}},t+0.4);
  /* exit whip */
  tl.to(sec,{{opacity:0,x:i%2? 60:-60,duration:0.14,ease:"power2.in"}},t+1.66);
  /* route progress */
  const frac = i/5;
  tl.to("#routeFill",{{scaleX:Math.max(frac,0.0001),duration:0.5,ease:"power2.inOut"}},t+(i==0?0.0:0.05));
  tl.to("#node"+i,{{backgroundColor:"#E53935",borderColor:"#ff8a80",scale:1.7,duration:0.3,ease:"back.out(2.5)"}},t+(i==0?0.0:0.4));
  tl.to("#node"+i,{{scale:1.15,duration:0.5,ease:"power2.out"}},t+0.75);
  flare(i%2?"#flare2":"#flare1",t,0.6,0.7);
  flash(t,0.08,0.18);
}}
tl.to("#routeLayer",{{opacity:0,duration:0.3,ease:"power2.in"}},23.9);

/* ---------- ACT 4: the promise ---------- */
slam("#run",T.run,T.know-0.05,{{from:1.25}});
flare("#flare1",T.run,1,1.1); flash(T.run,0.5,0.4); pulseRed(T.run,0.4,1.2);
tl.fromTo("#know",{{opacity:0,scale:1.25}},{{opacity:1,scale:1,duration:0.18,ease:"power4.out"}},T.know);
tl.to("#know",{{scale:1.03,duration:1.7,ease:"none"}},T.know+0.18);
flare("#flare2",T.know,1,1.2); flash(T.know,0.45,0.4);
tl.fromTo("#under",{{scaleX:0}},{{scaleX:1,duration:0.55,ease:"expo.out"}},T.know+0.12);
tl.to(["#run","#know","#under"],{{opacity:0,duration:0.2,ease:"power2.in"}},27.25);

/* ---------- ACT 5: end card ---------- */
flash(T.final,0.9,0.7); flare("#flare1",T.final,1,2.0); flare("#flare2",T.final+0.04,0.9,1.8); pulseRed(T.final,0.65,2.2);
tl.fromTo("#logoE",{{opacity:0,scale:1.1}},{{opacity:1,scale:1,duration:0.6,ease:"power3.out"}},T.final+0.02);
tl.to("#logoE",{{scale:1.04,duration:2.6,ease:"none"}},T.final+0.65);
tl.fromTo("#tagE",{{opacity:0,y:16}},{{opacity:1,y:0,duration:0.8,ease:"power2.out"}},T.final+0.8);
tl.to("#cover",{{opacity:1,duration:0.6,ease:"power2.in"}},T.end-0.6);

window.__timelines["main"] = tl;
</script>
</body></html>'''
    out = ROOT/f'hf-{fmt}'
    (out/'assets').mkdir(parents=True, exist_ok=True)
    grain(out/'assets'/'grain.png')
    (out/'index.html').write_text(html)
    (out/'hyperframes.json').write_text('{}') if not (out/'hyperframes.json').exists() else None
    print('wrote', out/'index.html', len(html))

for f in ('wide','tall'): build(f)
