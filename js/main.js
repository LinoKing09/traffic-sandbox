'use strict';
// ---------- Start, Hauptschleife, Speichern ----------
const SAVE_KEY = 'traffic-sandbox-save-v2';
const DT = 0.1;
const World = { seed: 1 };

function resize() {
  const cv = View.canvas;
  View.dpr = Math.min(window.devicePixelRatio || 1, 2);
  View.W = window.innerWidth; View.H = window.innerHeight;
  cv.width = Math.round(View.W * View.dpr); cv.height = Math.round(View.H * View.dpr);
  cv.style.width = View.W + 'px'; cv.style.height = View.H + 'px';
  if (typeof measureInsets === 'function') measureInsets();
}

function newWorld(seed) {
  World.seed = seed;
  Terrain.init(seed);
  netReset();
  Sim.reset();
  const towns = Terrain.townsInRect(-4000, -4000, 4000, 4000).sort((a, b) => b.pop - a.pop);
  const t0 = towns[0];
  View.cx = t0 ? t0.x : 0; View.cy = t0 ? t0.y : 0;
  View.scale = clamp(Math.min(View.W, View.H) / (t0 ? Terrain.townRadius(t0) * 3.2 : 600), 0.35, 1.6);
  if (typeof cancelBuild === 'function') cancelBuild();
}

function saveGame() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({ v: 2, seed: World.seed, net: netSerialize(), cam: { x: View.cx, y: View.cy, s: View.scale }, demand: Sim.demand, stats: Sim.stats, time: Sim.time }));
    return true;
  } catch (err) { return false; }
}

function loadGame() {
  let data = null;
  try { data = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); } catch (err) { data = null; }
  if (!data || !data.net) return false;
  World.seed = data.seed;
  Terrain.init(data.seed);
  Sim.reset();
  netDeserialize(data.net);
  if (data.stats) Object.assign(Sim.stats, data.stats);
  Sim.time = data.time || 0; Sim.lastHist = Sim.time; Sim.lastStat = Sim.time; Sim.nextEpoch = 0;
  Sim.demand = data.demand || 1;
  View.cx = data.cam.x; View.cy = data.cam.y; View.scale = data.cam.s;
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
    while (simAcc >= DT) {
      Sim.step(DT);
      simAcc -= DT;
      if (performance.now() - t0 > 30) { simAcc = 0; break; }
    }
  }
  if (frameNo % 30 === 0 && Net.dirty.size) netRebuild();
  updatePreview();
  render();
  if (frameNo % 15 === 0) updatePanels();
  if (now - lastSave > 60000) { lastSave = now; saveGame(); }
  requestAnimationFrame(frame);
}

window.addEventListener('load', () => {
  View.canvas = document.getElementById('c');
  View.ctx = View.canvas.getContext('2d');
  resize();
  window.addEventListener('resize', resize);
  uiInit();
  resize();
  if (!loadGame()) {
    newWorld(Math.floor(Math.random() * 1e6) + 1);
    document.getElementById('help').classList.remove('hidden');
  }
  window.addEventListener('pagehide', saveGame);
  document.addEventListener('visibilitychange', () => { if (document.hidden) saveGame(); });
  requestAnimationFrame(frame);
});
