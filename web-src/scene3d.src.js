// Hero scene: a dotted globe, trade lanes out of Dubai with containers travelling along them, and one branded container.
// Built to /assets/scene3d.js with scripts/build-scene.mjs (three.js, tree-shaken). Loaded only when the hero is visible.
import {
  WebGLRenderer, Scene, PerspectiveCamera, Group, SphereGeometry, MeshBasicMaterial, MeshStandardMaterial, Mesh, Points, BufferGeometry,
  Float32BufferAttribute, PointsMaterial, CanvasTexture, Color, Vector3, QuadraticBezierCurve3, Line, LineBasicMaterial, BoxGeometry,
  AmbientLight, DirectionalLight, PointLight, RingGeometry, DoubleSide, AdditiveBlending, BackSide, ShaderMaterial, SRGBColorSpace, MathUtils,
} from "three";

const LAND = "0360;0360;0360;0360;0360;0360;0141,12,207;094,2,1,21,15,25,202;089,25,4,39,2,9,192;084,7,6,13,3,51,35,2,1,3,22,4,41,6,82;085,21,8,47,30,8,2,4,68,7,80;067,3,5,5,1,3,3,4,1,13,2,53,32,7,81,5,75;061,3,4,1,16,1,6,10,9,50,33,4,4,1,80,2,75;058,4,8,2,7,3,2,5,2,10,9,49,86,4,32,11,68;063,7,1,3,5,3,2,2,1,6,1,5,22,39,77,6,27,24,23,8,35;066,2,22,6,1,1,25,37,76,3,27,24,70;056,8,9,2,4,4,1,5,2,3,2,2,1,3,22,35,75,3,24,32,1,5,4,4,13,3,37;055,6,1,9,1,3,3,5,1,2,4,9,3,1,22,33,74,4,13,4,8,48,10,6,35;11,8,5,42,4,1,14,5,3,1,3,3,16,1,1,17,33,74,4,12,4,1,2,1,53,3,1,2,2,1,13,29;019,10,37,11,7,4,3,20,14,29,2,1,47,7,36,6,1,86,20;017,24,4,15,3,14,3,4,1,4,5,4,5,10,13,2,1,27,42,15,27,4,3,6,1,94,2,8,2;01,195,22,14,2,3,10,2,5,1,105;04,190,27,3,2,2,25,2,105;05,1,3,184,20,2,6,3,28,1,107;11,7,184,10,3,10,5,140;06,1,8,1,3,73,2,4,4,3,1,8,14,11,19,7,26,10,3,11,2,141,2;08,2,9,70,5,2,2,1,9,7,14,10,50,11,2,157,1;015,73,8,2,4,1,7,3,17,7,49,12,3,156,1,1,1;014,72,16,6,23,6,48,12,4,136,2,3,2,9,7;015,17,2,52,16,8,24,3,48,13,4,133,7,9,9;018,8,2,2,10,45,17,9,3,2,69,13,7,2,1,121,2,4,5,3,17;023,3,16,45,15,10,1,4,58,2,9,3,2,6,7,117,18,3,18;022,2,1,3,18,41,16,15,56,4,12,1,1,5,5,1,1,116,17,6,17;020,2,26,44,11,15,56,3,11,3,1,4,5,117,18,7,17;017,2,29,46,8,18,54,4,10,2,1,3,7,115,19,7,18;015,1,33,49,2,23,48,3,2,3,10,1,6,3,1,117,19,5,19;047,1,3,47,3,23,47,3,3,3,7,134,1,1,13,4,20;052,46,3,23,47,2,3,6,2,137,1,1,13,2,22;052,48,1,22,1,1,51,5,3,137,1,1,14,1,22;052,1,1,66,3,1,51,2,4,140,1,2,36;053,2,1,57,3,2,4,2,1,1,52,142,2,2,36;057,54,1,3,6,6,48,145,2,1,37;056,1,1,57,9,1,1,1,50,142,3,1,37;056,59,1,1,2,1,58,33,1,3,3,12,3,85,4,2,36;056,63,60,14,1,16,3,2,2,11,5,84,43;056,56,2,2,63,13,3,14,9,9,3,86,6,1,37;056,54,62,3,3,9,3,4,2,12,12,8,3,84,6,4,35;056,53,62,12,8,3,4,10,14,6,5,78,9,4,36;056,53,62,11,10,4,3,9,4,5,4,8,5,76,50;056,50,65,10,7,2,5,3,1,5,2,1,2,21,3,68,1,7,11,2,38;056,50,65,9,8,2,6,1,3,3,3,23,4,66,3,1,2,3,12,2,38;057,48,66,9,21,3,3,22,5,64,7,3,12,1,39;057,47,67,8,14,2,6,2,4,23,4,65,1,2,4,3,9,3,39;058,46,70,1,6,10,11,1,6,2,1,2,2,85,5,3,7,5,39;059,45,70,1,3,13,25,84,7,2,4,8,39;060,43,70,17,26,84,6,1,4,3,1,2,43;062,39,71,19,24,86,9,4,46;063,37,71,24,6,2,12,86,9,2,48;063,2,1,33,71,26,4,7,3,1,4,87,8,1,49;064,1,2,32,71,29,1,101,59;065,1,2,17,4,2,6,2,71,42,1,15,2,72,58;066,1,1,16,13,2,70,45,1,13,3,71,58;065,3,1,14,14,3,67,46,3,13,4,68,59;067,1,3,12,15,2,1,1,64,48,2,14,7,63,60;068,1,2,12,16,1,65,50,2,13,1,1,7,60,61;068,1,3,10,83,50,2,14,3,3,10,52,2,1,58;073,9,82,52,3,20,9,49,3,1,59;074,8,14,1,1,3,63,52,3,21,10,21,1,23,5,1,59;075,8,18,2,60,54,2,20,11,17,5,16,1,2,69;074,9,7,3,10,2,59,53,3,19,14,14,6,14,73;024,1,50,9,5,4,14,3,54,53,4,17,15,12,9,12,3,2,69;076,9,2,5,14,6,1,1,50,54,3,16,16,11,10,12,3,1,70;079,13,72,55,3,13,18,10,11,13,13,2,58;081,11,71,56,4,10,20,9,12,14,12,2,58;087,9,67,57,3,9,22,6,18,11,11,2,58;088,9,66,58,2,6,25,6,18,11,11,2,58;090,6,67,59,1,4,28,5,18,11,13,2,56;093,4,66,60,32,5,18,2,2,7,15,1,55;094,2,11,1,56,59,6,2,25,4,19,1,3,6,13,1,2,1,54;094,3,7,4,1,5,2,3,46,59,1,6,25,4,18,1,5,3,12,1,60;096,2,2,1,3,4,1,10,47,65,25,3,1,1,17,1,6,1,12,1,6,1,54;096,4,2,18,47,63,27,1,2,1,17,2,23,1,1,1,54;099,1,2,19,46,63,30,2,17,1,22,1,1,3,53;0103,19,47,60,31,2,18,2,14,2,6,1,55;0102,25,43,10,5,44,51,3,13,3,61;0103,25,44,1,13,42,48,2,3,2,11,5,61;0103,26,61,37,50,2,2,2,10,4,63;0101,28,61,36,52,2,2,2,7,7,62;0101,29,59,36,54,3,1,1,5,9,10,1,51;0100,30,59,34,56,4,6,9,2,4,4,1,51;0100,31,58,33,58,4,5,9,14,1,47;099,36,54,33,59,3,6,7,2,3,9,3,46;099,36,1,1,53,31,60,5,4,7,2,3,11,1,2,4,40;0100,41,50,29,62,4,8,2,3,1,1,1,4,1,3,1,2,10,37;099,43,49,28,64,3,16,1,13,9,35;099,46,47,27,65,2,16,1,11,1,3,8,2,1,1,2,28;099,46,47,27,67,3,25,1,3,10,7,1,24;0100,45,48,26,68,6,25,9,11,1,21;0101,44,48,26,75,1,2,2,1,1,1,1,3,1,13,3,3,2,32;0101,43,49,27,79,1,4,1,22,2,11,2,18;0102,42,49,27,110,1,29;0103,40,51,26,92,1,9,1,37;0103,39,51,28,8,1,81,6,5,1,37;0104,37,52,28,8,1,80,6,6,2,36;0104,37,51,29,7,2,76,2,1,7,6,3,35;0105,36,51,28,7,3,74,12,6,3,35;1359,1;0109,32,51,26,6,5,73,18,1,5,32,1,1;0110,30,52,24,8,5,73,24,34;0110,30,53,22,9,5,72,26,33;0110,30,53,22,9,5,69,31,15,1,15;0110,29,55,21,8,5,67,34,16,1,14;0110,28,56,22,7,5,66,36,30;0110,25,59,21,9,4,66,37,29;0109,24,62,20,9,3,66,39,28;0109,23,63,18,12,1,68,39,27;0109,22,64,18,80,40,27;0109,22,64,18,81,39,27;0109,22,65,16,83,39,26;0109,21,67,14,84,38,27;0108,22,67,14,84,38,27;0108,21,69,12,86,37,27;0109,19,70,11,87,10,8,18,28;0108,19,71,9,88,9,11,2,1,13,29;0108,14,1,3,73,2,95,3,16,1,1,14,29;0107,16,195,12,23,1,6;0107,16,197,10,24,1,5;0106,17,197,10,25,1,4;0107,14,202,1,1,2,28,3,2;0107,11,236,3,3;0106,12,237,2,3;0106,9,210,3,24,2,1,1,4;0106,11,208,3,23,3,6;0107,8,211,1,23,3,7;0106,9,233,3,9;0105,8,234,4,9;0105,8,235,2,10;0105,9,246;0104,9,247;0104,8,137,1,110;0105,6,249;0105,6,8,3,238;0106,4,250;0106,6,248;0108,6,246;0111,1,248;0360;0360;0360;0360;0360;0360;0360;0121,2,237;0118,1,241;0116,1,198,1,44;0113,3,115,6,44,4,6,4,15,6,44;0112,3,113,12,22,64,34;0112,3,108,26,10,71,30;0108,2,2,5,95,6,2,30,7,81,22;0108,3,1,6,68,4,2,10,2,44,5,88,19;0105,7,1,6,50,2,2,75,4,99,9;0113,6,48,184,9;053,2,2,2,18,5,3,10,4,3,5,12,45,185,11;044,10,1,3,2,7,1,1,10,38,47,182,14;034,81,46,183,16;034,76,42,192,16;022,83,43,196,16;016,3,4,79,29,5,8,203,13;018,3,10,72,26,8,13,191,19;033,74,7,6,6,8,16,190,20;025,90,24,202,19;027,94,4,219,16;026,323,11;15,1,7,20,286,41;031,1,328;0360;0360;0360;0360";
const W = 360, H = 180;
const rad = (d) => (d * Math.PI) / 180;
const R = 2;
const toVec = (lat, lon, r = R) => new Vector3(r * Math.cos(rad(lat)) * Math.sin(rad(lon)), r * Math.sin(rad(lat)), r * Math.cos(rad(lat)) * Math.cos(rad(lon)));

function landCells() {
  const pts = [];
  LAND.split(";").forEach((row, j) => {
    let on = row[0] === "1", i = 0;
    row.slice(1).split(",").forEach((n) => { n = +n; if (on) for (let k = 0; k < n; k++) pts.push([90 - (j + 0.5) * 180 / H, -180 + (i + k + 0.5) * 360 / W]); i += n; on = !on; });
  });
  return pts;
}
function dotTexture() {
  const c = document.createElement("canvas"); c.width = c.height = 64; const g = c.getContext("2d");
  const grd = g.createRadialGradient(32, 32, 0, 32, 32, 32); grd.addColorStop(0, "#fff"); grd.addColorStop(.55, "#fff"); grd.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grd; g.beginPath(); g.arc(32, 32, 32, 0, 7); g.fill(); return new CanvasTexture(c);
}
function containerTexture(side) {
  const c = document.createElement("canvas"); c.width = 1024; c.height = 320; const g = c.getContext("2d");
  g.fillStyle = "#143A57"; g.fillRect(0, 0, 1024, 320);
  for (let x = 0; x < 1024; x += 16) { g.fillStyle = (x / 16) % 2 ? "rgba(255,255,255,.07)" : "rgba(0,0,0,.18)"; g.fillRect(x, 0, 8, 320); }
  g.fillStyle = "rgba(0,0,0,.35)"; g.fillRect(0, 0, 1024, 16); g.fillRect(0, 304, 1024, 16);
  if (side) {
    g.textBaseline = "alphabetic"; g.fillStyle = "#fff"; g.font = "900 120px Archivo, Arial Black, sans-serif";
    const l = g.measureText("LOAD").width, t = g.measureText("TON").width, gap = 70, total = l + gap + t + 40; let x = (1024 - total) / 2;
    g.fillText("LOAD", x, 205); x += l + 20; g.fillStyle = "#E53935"; g.fillRect(x, 95, 8, 120); g.fillRect(x + 62, 95, 8, 120);
    g.fillStyle = "#fff"; g.font = "800 50px Archivo, Arial Black, sans-serif"; g.textAlign = "center"; g.fillText("B", x + 35, 142); g.fillText("Y", x + 35, 200); g.textAlign = "left";
    g.font = "900 120px Archivo, Arial Black, sans-serif"; g.fillText("TON", x + 90, 205);
    g.fillStyle = "rgba(255,255,255,.7)"; g.font = "600 22px monospace"; g.fillText("LBTU 482019 6  ·  40' HC", 40, 285);
  } else {
    g.fillStyle = "rgba(255,255,255,.55)"; for (let i = 0; i < 4; i++) g.fillRect(180 + i * 180, 40, 10, 240);
    g.fillStyle = "#E53935"; g.fillRect(0, 150, 1024, 14);
  }
  const t = new CanvasTexture(c); t.colorSpace = SRGBColorSpace; t.anisotropy = 4; return t;
}

const PORTS = [
  ["Nhava Sheva", 18.95, 72.95], ["Mundra", 22.74, 69.7], ["Colombo", 6.93, 79.85], ["Jeddah", 21.5, 39.2], ["Mombasa", -4.05, 39.67], ["Piraeus", 37.94, 23.65],
  ["Rotterdam", 51.95, 4.14], ["Singapore", 1.26, 103.8], ["Shanghai", 31.2, 121.5], ["Durban", -29.9, 31.0], ["Santos", -23.96, -46.3], ["Los Angeles", 33.7, -118.2],
];
const DUBAI = [25.0, 55.1];

export function mountGlobe(el, opts = {}) {
  const reduced = !!opts.reduced;
  const renderer = new WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.outputColorSpace = SRGBColorSpace;
  const canvas = renderer.domElement; canvas.setAttribute("aria-hidden", "true"); el.appendChild(canvas);
  const scene = new Scene();
  const camera = new PerspectiveCamera(34, 1, 0.1, 100); camera.position.set(0, 0.3, 8.8);
  scene.add(new AmbientLight(0x9fb8d0, 0.9));
  const sun = new DirectionalLight(0xffffff, 1.6); sun.position.set(4, 3, 5); scene.add(sun);
  const warm = new PointLight(0xe53935, 18, 9); warm.position.copy(toVec(DUBAI[0], DUBAI[1], 3.1)); const world = new Group(); world.add(warm);
  scene.add(world);

  // planet body + atmosphere
  world.add(new Mesh(new SphereGeometry(R * 0.995, 64, 48), new MeshStandardMaterial({ color: 0x0c2538, roughness: 0.9, metalness: 0.1, emissive: 0x06141f, emissiveIntensity: 0.9 })));
  const atmos = new Mesh(new SphereGeometry(R * 1.14, 64, 48), new ShaderMaterial({
    transparent: true, side: BackSide, blending: AdditiveBlending, depthWrite: false,
    vertexShader: "varying vec3 n;void main(){n=normalize(normalMatrix*normal);gl_Position=projectionMatrix*modelViewMatrix*vec4(position,1.);}",
    fragmentShader: "varying vec3 n;void main(){float i=pow(.72-dot(n,vec3(0.,0.,1.)),3.);gl_FragColor=vec4(.30,.62,.95,1.)*i*1.5;}",
  }));
  scene.add(atmos);

  // land dots
  const land = landCells(), pos = new Float32Array(land.length * 3), v = new Vector3();
  land.forEach(([lat, lon], i) => { v.copy(toVec(lat, lon, R * 1.002)); pos[i * 3] = v.x; pos[i * 3 + 1] = v.y; pos[i * 3 + 2] = v.z; });
  const g = new BufferGeometry(); g.setAttribute("position", new Float32BufferAttribute(pos, 3));
  const dot = dotTexture();
  world.add(new Points(g, new PointsMaterial({ size: 0.036, map: dot, alphaTest: 0.2, transparent: true, color: new Color(0x86bde8), sizeAttenuation: true, depthWrite: false })));

  // hub + ports
  const hub = toVec(DUBAI[0], DUBAI[1], R * 1.01);
  const hubDot = new Mesh(new SphereGeometry(0.055, 16, 16), new MeshBasicMaterial({ color: 0xe53935 })); hubDot.position.copy(hub); world.add(hubDot);
  const rings = [0, 1].map(() => { const m = new Mesh(new RingGeometry(0.06, 0.075, 40), new MeshBasicMaterial({ color: 0xff6b66, transparent: true, side: DoubleSide, depthWrite: false })); m.position.copy(hub); m.lookAt(hub.clone().multiplyScalar(2)); world.add(m); return m; });
  const lanes = [];
  PORTS.forEach(([, lat, lon], idx) => {
    const end = toVec(lat, lon, R * 1.01);
    const p = new Mesh(new SphereGeometry(0.03, 10, 10), new MeshBasicMaterial({ color: 0xffffff })); p.position.copy(end); world.add(p);
    const mid = hub.clone().add(end).multiplyScalar(0.5); const lift = 1 + Math.min(hub.distanceTo(end) / R, 1.6) * 0.42; mid.setLength(R * lift);
    const curve = new QuadraticBezierCurve3(hub.clone(), mid, end);
    const line = new Line(new BufferGeometry().setFromPoints(curve.getPoints(64)), new LineBasicMaterial({ color: idx % 3 === 0 ? 0xff7b76 : 0x78b6ee, transparent: true, opacity: 0.55 }));
    world.add(line);
    const box = new Mesh(new BoxGeometry(0.15, 0.062, 0.062), new MeshStandardMaterial({ color: idx % 3 === 0 ? 0xe53935 : 0xf2f6fa, roughness: 0.4, metalness: 0.3, emissive: idx % 3 === 0 ? 0x5a0f0d : 0x1b2a38 }));
    world.add(box); lanes.push({ curve, box, t: (idx * 0.137) % 1, speed: 0.045 + (idx % 4) * 0.012 });
  });

  // the branded container, floating in front of the globe
  const sideT = containerTexture(true), endT = containerTexture(false);
  const sideM = new MeshStandardMaterial({ map: sideT, emissive: 0xffffff, emissiveMap: sideT, emissiveIntensity: 0.5, roughness: 0.55, metalness: 0.2 }), endM = new MeshStandardMaterial({ map: endT, emissive: 0xffffff, emissiveMap: endT, emissiveIntensity: 0.5, roughness: 0.55, metalness: 0.2 }), topM = new MeshStandardMaterial({ color: 0x1b4668, roughness: 0.7, metalness: 0.2, emissive: 0x0b2a40 });
  const box = new Mesh(new BoxGeometry(2.4, 0.78, 0.78), [endM, endM, topM, topM, sideM, sideM]);
  const boxGroup = new Group(); boxGroup.add(box); boxGroup.position.set(0.85, -0.95, 3.6); boxGroup.rotation.set(0.2, -0.5, 0.05); boxGroup.scale.setScalar(0.5); scene.add(boxGroup);

  // layout
  function size() { const w = el.clientWidth || 600, h = el.clientHeight || 600; renderer.setSize(w, h, false); camera.aspect = w / h; camera.fov = w / h < 0.8 ? 40 : 34; camera.updateProjectionMatrix(); }
  size(); const ro = new ResizeObserver(size); ro.observe(el);

  // interaction: gentle pointer parallax + horizontal drag with inertia (vertical swipes still scroll the page)
  let baseY = -rad(DUBAI[1]) + rad(8), drag = 0, vel = 0, down = false, lx = 0, px = 0, py = 0;
  canvas.style.touchAction = "pan-y"; canvas.style.cursor = "grab";
  canvas.addEventListener("pointerdown", (e) => { down = true; lx = e.clientX; canvas.setPointerCapture(e.pointerId); canvas.style.cursor = "grabbing"; });
  canvas.addEventListener("pointermove", (e) => { const b = canvas.getBoundingClientRect(); px = ((e.clientX - b.left) / b.width - 0.5); py = ((e.clientY - b.top) / b.height - 0.5); if (down) { const dx = e.clientX - lx; lx = e.clientX; drag += dx * 0.006; vel = dx * 0.006; } });
  const up = () => { down = false; canvas.style.cursor = "grab"; }; canvas.addEventListener("pointerup", up); canvas.addEventListener("pointercancel", up);

  let running = false, raf = 0, t0 = performance.now(), last = t0;
  function frame(now) {
    const dt = Math.min((now - last) / 1000, 0.05); last = now; const t = (now - t0) / 1000;
    if (!down) { drag += vel; vel *= 0.94; }
    world.rotation.y = baseY + drag + (reduced ? 0 : Math.sin(t * 0.18) * 0.38);
    world.rotation.x = MathUtils.lerp(world.rotation.x, 0.28 + py * 0.14, 0.05);
    world.rotation.z = MathUtils.lerp(world.rotation.z, -0.05 + px * 0.04, 0.05);
    camera.position.x = MathUtils.lerp(camera.position.x, px * 0.5, 0.04);
    atmos.rotation.copy(world.rotation);
    rings.forEach((r, i) => { const k = ((t * 0.6 + i * 0.5) % 1); r.scale.setScalar(1 + k * 7); r.material.opacity = (1 - k) * 0.6; });
    lanes.forEach((l) => { l.t = (l.t + dt * l.speed) % 1; const p = l.curve.getPoint(l.t), q = l.curve.getPoint(Math.min(l.t + 0.01, 1)); l.box.position.copy(p); l.box.lookAt(q); l.box.rotateY(Math.PI / 2); l.box.visible = true; });
    boxGroup.position.y = -0.95 + Math.sin(t * 0.9) * 0.06; boxGroup.rotation.y = -0.5 + Math.sin(t * 0.35) * 0.16;
    renderer.render(scene, camera);
    if (running) raf = requestAnimationFrame(frame);
  }
  function start() { if (running || reduced) return; running = true; last = performance.now(); raf = requestAnimationFrame(frame); }
  function stop() { running = false; cancelAnimationFrame(raf); }
  frame(performance.now());
  if (!reduced) {
    start();
    new IntersectionObserver((es) => (es[0].isIntersecting ? start() : stop())).observe(el);
    document.addEventListener("visibilitychange", () => (document.hidden ? stop() : start()));
    // the container wordmark uses Archivo; redraw once the face is ready
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(() => { const n = containerTexture(true); sideM.map.dispose(); sideM.map = n; sideM.emissiveMap = n; sideM.needsUpdate = true; });
  } else { canvas.addEventListener("pointermove", () => requestAnimationFrame(frame)); }
  window.addEventListener("pagehide", () => { stop(); ro.disconnect(); renderer.dispose(); });
  return { stop, start };
}
