'use strict';
// ---------- Start, Hauptschleife, Speichern ----------
const SAVE_KEY = 'traffic-sandbox-save-v1';
const DT = 0.1;
let World = { seed: 1 };

function resize() {
  const cv = View.canvas;
  View.dpr = Math.min(window.devicePixelRatio || 1, 2);
  View.W = window.innerWidth; View.H = window.innerHeight;
  cv.width = Math.round(View.W * View.dpr); cv.height = Math.round(View.H * View.dpr);
  cv.style.width = View.W + 'px'; cv.style.height = View.H + 'px';
}

function ensureTownNodes() {
  const r = viewRect(800);
  if (View.scale < 0.05) return;
  for (const t of Terrain.townsInRect(r.x0, r.y0, r.x1, r.y1)) {
    if (!t.node || t.node.deleted) {
      t.node = addNode(t.x, t.y, { town: t });
      Net.dirty.delete(t.node);
    }
  }
}

function newWorld(seed) {
  World.seed = seed;
  Terrain.init(seed);
  netReset();
  Sim.reset();
  // Startansicht: zwischen zwei groesseren Orten nahe Ursprung
  const towns = Terrain.townsInRect(-4000, -4000, 4000, 4000).sort((a, b) => b.pop - a.pop);
  const t0 = towns[0];
  if (t0) {
    const near = towns.filter(t => t !== t0).sort((a, b) => Math.hypot(a.x - t0.x, a.y - t0.y) - Math.hypot(b.x - t0.x, b.y - t0.y))[0];
    View.cx = near ? (t0.x + near.x) / 2 : t0.x;
    View.cy = near ? (t0.y + near.y) / 2 : t0.y;
    View.scale = near ? clamp(Math.min(View.W, View.H) * 0.55 / Math.max(300, Math.hypot(near.x - t0.x, near.y - t0.y)), 0.15, 1.2) : 0.6;
  } else { View.cx = 0; View.cy = 0; View.scale = 0.5; }
  ensureTownNodes();
  netRebuild();
  if (typeof cancelBuild === 'function') cancelBuild();
}

function saveGame() {
  try {
    const data = { v: 1, seed: World.seed, net: netSerialize(), cam: { x: View.cx, y: View.cy, s: View.scale }, demand: Sim.demand, stats: Sim.stats, time: Sim.time };
    localStorage.setItem(SAVE_KEY, JSON.stringify(data));
    return true;
  } catch (err) { console.warn(err); return false; }
}

function loadGame() {
  let data;
  try { data = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); } catch (err) { data = null; }
  if (!data || !data.net) return false;
  World.seed = data.seed;
  Terrain.init(data.seed);
  Sim.reset();
  netDeserialize(data.net);
  if (data.stats) Object.assign(Sim.stats, data.stats);
  Sim.time = data.time || 0; Sim.lastHist = Sim.time; Sim.lastStat = Sim.time; Sim.nextRoute = 0;
  Sim.demand = data.demand || 1;
  $('demand').value = Sim.demand; $('demandVal').textContent = Math.round(Sim.demand * 100) + ' %';
  View.cx = data.cam.x; View.cy = data.cam.y; View.scale = data.cam.s;
  ensureTownNodes();
  netRebuild();
  cancelBuild();
  return true;
}

let lastT = performance.now(), simAcc = 0, frameNo = 0, lastSave = performance.now();
function frame(now) {
  const dt = Math.min(0.1, (now - lastT) / 1000);
  lastT = now;
  frameNo++;
  panKeys(dt);
  if (!Sim.paused) {
    simAcc += dt * Sim.speed;
    const t0 = performance.now();
    let steps = 0;
    while (simAcc >= DT) {
      Sim.step(DT);
      simAcc -= DT; steps++;
      if (performance.now() - t0 > 30) { simAcc = 0; break; }
    }
  }
  if (frameNo % 20 === 0) {
    ensureTownNodes();
    if (Net.dirty.size) netRebuild();
  }
  if (UI.stage || View.preview) updateHover();
  render();
  if (frameNo % 15 === 0) updateStatsPanel();
  if (now - lastSave > 60000) { lastSave = now; saveGame(); }
  requestAnimationFrame(frame);
}

window.addEventListener('load', () => {
  View.canvas = document.getElementById('c');
  View.ctx = View.canvas.getContext('2d');
  resize();
  window.addEventListener('resize', resize);
  uiInit();
  if (!loadGame()) {
    newWorld(Math.floor(Math.random() * 1e6) + 1);
    document.getElementById('help').classList.remove('hidden');
  }
  window.addEventListener('beforeunload', saveGame);
  requestAnimationFrame(frame);
});
