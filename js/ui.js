'use strict';
// ---------- Bedienung ----------
const TOOLS = [
  { id: 'road', key: '1', icon: '🛣️', name: 'Straße', hint: 'Klick: Startpunkt setzen · Klick: Endpunkt (Kette läuft weiter) · Rechtsklick/Esc: beenden · Shift: Winkel einrasten · C: Kurvenmodus' },
  { id: 'bridge', key: '2', icon: '🌉', name: 'Brücke', hint: 'Hochstraße: kreuzt andere Straßen und Wasser ohne Kreuzung (Überführung).' },
  { id: 'tunnel', key: '3', icon: '🚇', name: 'Tunnel', hint: 'Unterführung: kreuzt Straßen, Flüsse und Berge ohne Kreuzung.' },
  { id: 'junction', key: '4', icon: '🚦', name: 'Kreuzung', hint: 'Kreuzung anklicken: Vorfahrt, Stoppschilder, Ampel oder Hauptrichtung wählen.' },
  { id: 'roundabout', key: '5', icon: '⭕', name: 'Kreisverkehr', hint: 'Kreuzung anklicken, um sie in einen Kreisverkehr umzubauen.' },
  { id: 'turnlane', key: '6', icon: '↰', name: 'Abbiegespur', hint: 'Nahe am Straßenende klicken: Linksabbiegespur vor der Kreuzung ein/aus.' },
  { id: 'upgrade', key: '7', icon: '⬆️', name: 'Umbauen', hint: 'Straße anklicken: übernimmt den gewählten Straßentyp. Einbahnstraße erneut anklicken = Richtung umdrehen.' },
  { id: 'bulldoze', key: '8', icon: '🧨', name: 'Abriss', hint: 'Straße oder Kreuzung anklicken, um sie abzureißen.' },
  { id: 'info', key: '9', icon: '🔍', name: 'Info', hint: 'Straße oder Kreuzung anklicken für Verkehrsdaten.' },
];

const UI = {
  tool: 'road', curve: false, preset: 'land', spec: Object.assign({}, ROAD_PRESETS.land),
  stage: 0, start: null, ctrl: null, mouse: { x: 0, y: 0, sx: 0, sy: 0 }, shift: false,
  pointers: new Map(), drag: null, keys: new Set(), lastToast: 0,
};

const $ = (id) => document.getElementById(id);

function uiInit() {
  // Werkzeuge
  const tb = $('tools');
  for (const t of TOOLS) {
    const b = document.createElement('button');
    b.className = 'tool'; b.dataset.tool = t.id;
    b.innerHTML = `<span class="ic">${t.icon}</span><span class="lb">${t.name}</span><kbd>${t.key}</kbd>`;
    b.title = t.name + ' (' + t.key + ')';
    b.onclick = () => setTool(t.id);
    tb.appendChild(b);
  }
  $('curveBtn').onclick = () => setCurve(!UI.curve);
  // Strassentypen
  const pp = $('presets');
  for (const [k, p] of Object.entries(ROAD_PRESETS)) {
    const b = document.createElement('button');
    b.className = 'preset'; b.dataset.preset = k;
    b.innerHTML = `<span class="pv">${presetIcon(p)}</span><span>${p.name}</span><small>${laneText(p)} · ${p.speed} km/h</small>`;
    b.onclick = () => setPreset(k);
    pp.appendChild(b);
  }
  for (const [id, f, d] of [['fMinus', 'nF', -1], ['fPlus', 'nF', 1], ['bMinus', 'nB', -1], ['bPlus', 'nB', 1]]) {
    $(id).onclick = () => {
      UI.spec[f] = clamp(UI.spec[f] + d, f === 'nF' ? 1 : 0, 4);
      if (UI.spec.nB === 0) UI.spec.median = 0;
      UI.preset = null; refreshRoadPanel();
    };
  }
  $('speedSel').onchange = (e) => { UI.spec.speed = +e.target.value; UI.preset = null; refreshRoadPanel(); };
  $('medianChk').onchange = (e) => { UI.spec.median = e.target.checked && UI.spec.nB > 0 ? 3 : 0; UI.preset = null; refreshRoadPanel(); };

  // Zeit
  document.querySelectorAll('#timeCtl button').forEach(b => {
    b.onclick = () => setSpeed(+b.dataset.speed);
  });
  $('demand').oninput = (e) => { Sim.demand = +e.target.value; $('demandVal').textContent = Math.round(Sim.demand * 100) + ' %'; };
  $('errSel').onchange = (e) => { Sim.errMul = +e.target.value; };
  $('flowBtn').onclick = () => { View.showFlow = !View.showFlow; $('flowBtn').classList.toggle('on', View.showFlow); };
  $('accBtn').onclick = () => { View.showAcc = !View.showAcc; $('accBtn').classList.toggle('on', View.showAcc); };
  $('saveBtn').onclick = () => { saveGame(); toast('💾 Gespeichert'); };
  $('loadBtn').onclick = () => { if (loadGame()) toast('📂 Spielstand geladen'); else toast('Kein Spielstand gefunden'); };
  $('newBtn').onclick = () => {
    const s = prompt('Neue Welt erzeugen. Seed (Zahl) eingeben:', String(Math.floor(Math.random() * 1e6)));
    if (s === null) return;
    newWorld(Math.abs(parseInt(s, 10)) || 1);
  };
  $('helpBtn').onclick = () => $('help').classList.remove('hidden');
  $('helpClose').onclick = () => $('help').classList.add('hidden');
  $('panelToggle').onclick = () => document.body.classList.toggle('panel-collapsed');

  // Eingabe
  const cv = View.canvas;
  cv.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
  cv.addEventListener('wheel', onWheel, { passive: false });
  cv.addEventListener('contextmenu', e => e.preventDefault());
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', e => { UI.keys.delete(e.key.toLowerCase()); if (e.key === 'Shift') UI.shift = false; });

  Sim.onAccident = (rec, N) => {
    const now = performance.now();
    if (now - UI.lastToast < 2500) return;
    UI.lastToast = now;
    toast('💥 Unfall! ' + (N ? 'An einer Kreuzung' : 'Auffahrunfall') + ' – Klick zum Hinsehen', () => { View.cx = rec.x; View.cy = rec.y; View.scale = Math.max(View.scale, 1.5); });
  };

  setTool('road');
  setPreset('land');
  setSpeed(1);
}

function presetIcon(p) {
  return p.nB === 0 ? '➡' : p.median ? '⇉' : (p.nF > 1 ? '⇶' : '⇄');
}
function laneText(p) { return p.nB === 0 ? p.nF + ' Spur(en) einbahn' : p.nF + '+' + p.nB + ' Spuren'; }

function setTool(id) {
  UI.tool = id;
  document.querySelectorAll('.tool').forEach(b => b.classList.toggle('on', b.dataset.tool === id));
  const t = TOOLS.find(x => x.id === id);
  $('hint').textContent = t ? t.hint : '';
  cancelBuild();
  hidePopup();
  const roadTool = ['road', 'bridge', 'tunnel', 'upgrade'].includes(id);
  $('roadpanel').classList.toggle('dim', !roadTool);
  View.hover = null;
}
function setCurve(on) {
  UI.curve = on;
  $('curveBtn').classList.toggle('on', on);
  if (UI.stage === 2) UI.stage = 1;
  UI.ctrl = null;
}
function setPreset(k) {
  UI.preset = k;
  UI.spec = Object.assign({}, ROAD_PRESETS[k]);
  refreshRoadPanel();
}
function refreshRoadPanel() {
  document.querySelectorAll('.preset').forEach(b => b.classList.toggle('on', b.dataset.preset === UI.preset));
  $('fVal').textContent = UI.spec.nF;
  $('bVal').textContent = UI.spec.nB;
  $('speedSel').value = String(UI.spec.speed);
  $('medianChk').checked = UI.spec.median > 0;
  $('medianChk').disabled = UI.spec.nB === 0;
}
function setSpeed(sp) {
  Sim.paused = sp === 0;
  if (sp > 0) Sim.speed = sp;
  document.querySelectorAll('#timeCtl button').forEach(b => b.classList.toggle('on', +b.dataset.speed === sp));
}

function toolLevel() { return UI.tool === 'bridge' ? 1 : UI.tool === 'tunnel' ? -1 : 0; }
function isBuildTool() { return UI.tool === 'road' || UI.tool === 'bridge' || UI.tool === 'tunnel'; }

function cancelBuild() { UI.stage = 0; UI.start = null; UI.ctrl = null; View.preview = null; }

function toast(msg, onClick) {
  const t = document.createElement('div');
  t.className = 'toastItem'; t.textContent = msg;
  if (onClick) { t.style.cursor = 'pointer'; t.onclick = () => { onClick(); t.remove(); }; }
  $('toast').appendChild(t);
  setTimeout(() => t.classList.add('fade'), 3200);
  setTimeout(() => t.remove(), 4000);
}

// ---------- Zeiger ----------
function onPointerDown(e) {
  View.canvas.setPointerCapture && View.canvas.setPointerCapture(e.pointerId);
  UI.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY, button: e.button, moved: false });
  hidePopupIfOutside(e);
  if (UI.pointers.size === 2) {
    const [a, b] = [...UI.pointers.values()];
    UI.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), scale: View.scale };
  }
}

function onPointerMove(e) {
  const r = View.canvas.getBoundingClientRect();
  const sx = e.clientX - r.left, sy = e.clientY - r.top;
  const p = UI.pointers.get(e.pointerId);
  if (p) {
    const dx = e.clientX - p.x, dy = e.clientY - p.y;
    if (Math.hypot(e.clientX - p.sx, e.clientY - p.sy) > 6) p.moved = true;
    if (UI.pointers.size === 2 && UI.pinch) {
      p.x = e.clientX; p.y = e.clientY;
      const [a, b] = [...UI.pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      zoomAt((a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top, clamp(UI.pinch.scale * d / UI.pinch.d, 0.04, 8) / View.scale);
      return;
    }
    if (p.moved) { View.cx -= dx / View.scale; View.cy -= dy / View.scale; }
    p.x = e.clientX; p.y = e.clientY;
  }
  UI.mouse.sx = sx; UI.mouse.sy = sy;
  const w = s2w(sx, sy);
  UI.mouse.x = w.x; UI.mouse.y = w.y;
  UI.shift = e.shiftKey;
  updateHover();
}

function onPointerUp(e) {
  const p = UI.pointers.get(e.pointerId);
  UI.pointers.delete(e.pointerId);
  if (UI.pointers.size < 2) UI.pinch = null;
  if (!p || p.moved) return;
  if (e.target !== View.canvas) return;
  if (p.button === 2) { if (UI.stage) cancelBuild(); else hidePopup(); return; }
  if (p.button !== 0) return;
  onClick();
}

function zoomAt(sx, sy, f) {
  const before = s2w(sx, sy);
  View.scale = clamp(View.scale * f, 0.04, 8);
  const after = s2w(sx, sy);
  View.cx += before.x - after.x; View.cy += before.y - after.y;
}

function onWheel(e) {
  e.preventDefault();
  const r = View.canvas.getBoundingClientRect();
  zoomAt(e.clientX - r.left, e.clientY - r.top, Math.pow(1.0015, -e.deltaY));
}

function onKeyDown(e) {
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
  const k = e.key.toLowerCase();
  UI.keys.add(k);
  if (e.key === 'Shift') UI.shift = true;
  const t = TOOLS.find(x => x.key === e.key);
  if (t) { setTool(t.id); return; }
  if (k === 'escape') { cancelBuild(); hidePopup(); View.selected = null; $('help').classList.add('hidden'); }
  else if (k === 'c') setCurve(!UI.curve);
  else if (k === ' ') { e.preventDefault(); setSpeed(Sim.paused ? Sim.speed : 0); }
  else if (k === 'f') $('flowBtn').click();
  else if (k === 'x' || k === 'delete') setTool('bulldoze');
  else if (k === 'q') setTool('info');
  else if (k === '+' || k === '=') zoomAt(View.W / 2, View.H / 2, 1.25);
  else if (k === '-') zoomAt(View.W / 2, View.H / 2, 0.8);
}

function panKeys(dt) {
  const sp = 600 * dt / View.scale;
  const K = UI.keys;
  if (K.has('w') || K.has('arrowup')) View.cy -= sp;
  if (K.has('s') || K.has('arrowdown')) View.cy += sp;
  if (K.has('a') || K.has('arrowleft')) View.cx -= sp;
  if (K.has('d') || K.has('arrowright')) View.cx += sp;
}

// ---------- Werkzeug-Logik ----------
function currentSnap() {
  let sn = snapPoint(UI.mouse.x, UI.mouse.y, View.scale);
  if (sn.type === 'free' && UI.shift && UI.start) {
    const ref = UI.stage === 2 && UI.ctrl ? UI.ctrl : UI.start;
    const dx = sn.x - ref.x, dy = sn.y - ref.y;
    const d = Math.hypot(dx, dy);
    const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 12)) * (Math.PI / 12);
    sn = { type: 'free', x: ref.x + Math.cos(a) * d, y: ref.y + Math.sin(a) * d };
  }
  return sn;
}

function updateHover() {
  const x = UI.mouse.x, y = UI.mouse.y, s = View.scale;
  View.hover = null;
  if (isBuildTool()) {
    const sn = currentSnap();
    if (UI.stage === 0) {
      View.preview = null;
      if (sn.type !== 'free') View.hover = sn.type === 'node' ? { node: sn.node, color: '#4fc3f7' } : null;
      UI.snapNow = sn;
      return;
    }
    const spec = UI.spec, level = toolLevel();
    let p0 = UI.start, c, p1 = sn, ctrlShown = false;
    if (UI.curve && UI.stage === 1) { c = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 }; }
    else if (UI.curve && UI.stage === 2) { c = UI.ctrl; ctrlShown = true; }
    else c = { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
    const len = Math.hypot(c.x - p0.x, c.y - p0.y) + Math.hypot(p1.x - c.x, p1.y - c.y);
    View.preview = { p0, c, p1, spec, level, ok: len >= 10, snap0: UI.start, snap1: sn, ctrlShown, len };
    UI.snapNow = sn;
    return;
  }
  View.preview = null;
  const r = Math.max(4, 12 / s);
  if (UI.tool === 'junction' || UI.tool === 'roundabout') {
    const N = pickNode(x, y, Math.max(r, 15));
    if (N && N.edges.length >= (UI.tool === 'junction' ? 3 : 2) && !N.ring) View.hover = { node: N };
  } else if (UI.tool === 'turnlane') {
    const pe = pickEdge(x, y, r, e => !e.ring);
    if (pe) View.hover = { edge: pe.edge, end: pe.u > pe.edge.len / 2 };
  } else if (UI.tool === 'bulldoze') {
    const N = pickNode(x, y, r);
    if (N && !N.town && N.edges.length >= 3) View.hover = { node: N, color: '#ff5252' };
    else { const pe = pickEdge(x, y, r); if (pe) View.hover = { edge: pe.edge, color: '#ff5252' }; }
  } else if (UI.tool === 'upgrade') {
    const pe = pickEdge(x, y, r);
    if (pe) View.hover = { edge: pe.edge, color: '#7CFC9A' };
  } else if (UI.tool === 'info') {
    const N = pickNode(x, y, r);
    if (N && (N.edges.length >= 3 || N.town)) View.hover = { node: N };
    else { const pe = pickEdge(x, y, r); if (pe) View.hover = { edge: pe.edge }; }
  }
}

function onClick() {
  updateHover();
  const tool = UI.tool;
  if (isBuildTool()) {
    const sn = UI.snapNow || currentSnap();
    if (UI.stage === 0) {
      UI.start = sn; UI.stage = 1; updateHover(); return;
    }
    if (UI.curve && UI.stage === 1) {
      UI.ctrl = { x: sn.x, y: sn.y }; UI.stage = 2; updateHover(); return;
    }
    const res = buildRoad(UI.start, UI.curve ? UI.ctrl : null, sn, UI.spec, toolLevel());
    if (!res.ok) { toast('⚠️ ' + res.msg); return; }
    const E = res.end;
    UI.start = { type: 'node', node: E, x: E.x, y: E.y };
    UI.stage = 1; UI.ctrl = null;
    updateHover();
    return;
  }
  const h = View.hover;
  if (tool === 'junction') {
    if (h && h.node) showJunctionPopup(h.node);
    else hidePopup();
  } else if (tool === 'roundabout') {
    if (h && h.node) {
      const res = buildRoundabout(h.node);
      toast(res.ok ? '⭕ Kreisverkehr gebaut' : '⚠️ ' + res.msg);
    }
  } else if (tool === 'turnlane') {
    if (h && h.edge) {
      const on = toggleTurnLane(h.edge, h.end);
      const e = h.edge;
      const L = h.end ? e.linkF : e.linkB;
      if (on && !(L && L.turnLane)) toast('⚠️ Straße zu kurz für eine Abbiegespur (min. ~60 m)');
      else toast(on ? '↰ Abbiegespur hinzugefügt' : 'Abbiegespur entfernt');
    }
  } else if (tool === 'upgrade') {
    if (h && h.edge) upgradeEdge(h.edge, UI.spec);
  } else if (tool === 'bulldoze') {
    if (h && h.node) { removeNode(h.node); netRebuild(); }
    else if (h && h.edge) { removeEdge(h.edge); netRebuild(); }
    View.hover = null;
  } else if (tool === 'info') {
    View.selected = h ? Object.assign({}, h) : null;
    updateInfo();
  }
}

// ---------- Kreuzungs-Popup ----------
const CTL_NAMES = { auto: 'Vorfahrt (Schilder)', stop: 'Stopp an Nebenstraßen', allstop: 'Allseitig Stopp', light: 'Ampel (adaptiv)', ringnode: 'Kreisverkehr' };

function showJunctionPopup(N) {
  const pop = $('popup');
  const p = w2s(N.x, N.y);
  pop.innerHTML = `<div class="ptitle">Kreuzungssteuerung</div>` +
    ['auto', 'stop', 'allstop', 'light'].map(k => `<button data-ctl="${k}" class="${N.ctl === k ? 'on' : ''}">${{ auto: '🔻', stop: '🛑', allstop: '⛔', light: '🚦' }[k]} ${CTL_NAMES[k]}</button>`).join('') +
    (N.ctl !== 'light' && N.ctl !== 'allstop' && (N.majorCount || 0) > 1 ? `<button data-act="major">🔀 Hauptstraße wechseln</button>` : '') +
    `<button data-act="ring">⭕ Zu Kreisverkehr umbauen</button>` +
    `<div class="pstat">Durchsatz: ${Math.round(N.thr)} Fz/h · Ø Wartezeit: ${N.waitAvg.toFixed(1)} s · Unfälle: ${N.accidents}</div>`;
  pop.style.left = clamp(p.x + 20, 10, View.W - 260) + 'px';
  pop.style.top = clamp(p.y - 40, 60, View.H - 300) + 'px';
  pop.classList.remove('hidden');
  pop.querySelectorAll('button').forEach(b => {
    b.onclick = () => {
      if (b.dataset.ctl) { setNodeControl(N, b.dataset.ctl); showJunctionPopup(N); }
      else if (b.dataset.act === 'major') { N.majorPick = (N.majorPick + 1) % (N.majorCount || 1); Net.dirty.add(N); netRebuild(); showJunctionPopup(N); }
      else if (b.dataset.act === 'ring') { const r = buildRoundabout(N); toast(r.ok ? '⭕ Kreisverkehr gebaut' : '⚠️ ' + r.msg); hidePopup(); }
    };
  });
  View.selected = { node: N };
}
function hidePopup() { $('popup').classList.add('hidden'); if (UI.tool === 'junction') View.selected = null; }
function hidePopupIfOutside(e) { if (!$('popup').contains(e.target)) hidePopup(); }

// ---------- Panels ----------
function fmtTime(s) { const m = Math.floor(s / 60); return m + ':' + String(Math.floor(s % 60)).padStart(2, '0'); }

function updateStatsPanel() {
  const st = Sim.stats, R = simRating();
  let waiting = 0, towns = 0;
  for (const N of Sim.townNodes) { waiting += N.town.queue.length; towns++; }
  const active = Sim.vehicles.filter(v => !v.dead).length;
  const avgTrip = st.trips ? st.tripTime / st.trips : 0;
  const gc = { A: '#2ecc71', B: '#8bd346', C: '#f1c40f', D: '#e67e22', E: '#e74c3c', F: '#b71c1c' }[R.grade];
  const enough = Sim.history.length >= 6 && active > 5;
  $('grade').textContent = enough ? R.grade : '–';
  $('grade').style.background = enough ? gc : '#566';
  $('gradeTxt').innerHTML = enough ? `Verkehrsnote · ${Math.round(R.score)}/100` : (towns < 2 ? 'Verbinde mindestens zwei Orte mit Straßen' : 'Sammle Daten …');
  $('sClock').textContent = 'Simzeit ' + fmtTime(Sim.time);
  const rows = [
    ['🚗 Unterwegs', active],
    ['🌊 Verkehrsfluss', Math.round(Sim.flowIdx * 100) + ' %', Sim.flowIdx > 0.7 ? 'good' : Sim.flowIdx > 0.45 ? 'mid' : 'bad'],
    ['🐌 Stau-Anteil', Math.round(Sim.jam * 100) + ' %', Sim.jam < 0.15 ? 'good' : Sim.jam < 0.35 ? 'mid' : 'bad'],
    ['🏁 Fahrten', st.trips.toLocaleString('de-DE')],
    ['⏱ Durchsatz', Math.round(R.tripsPerH).toLocaleString('de-DE') + ' Fz/h'],
    ['⌛ Ø Fahrzeit', fmtTime(avgTrip)],
    ['💥 Unfälle', st.accidents + (R.accWin ? ` (${R.accWin} in 10 min)` : ''), R.accRate < 2 ? 'good' : R.accRate < 8 ? 'mid' : 'bad'],
    ['📊 pro 1000 Fahrten', R.accRate.toFixed(1)],
    ['🏘 Warten in Orten', waiting + (st.rejected ? ` · ${st.rejected} abgewiesen` : ''), waiting < 20 ? 'good' : waiting < 80 ? 'mid' : 'bad'],
    ['🚧 Abgeschleppt / aufgegeben', st.towed + ' / ' + st.gaveUp],
  ];
  $('statRows').innerHTML = rows.map(r => `<div class="row"><span>${r[0]}</span><b class="${r[2] || ''}">${r[1]}</b></div>`).join('');
  drawChart();
  // Brennpunkte
  const nodes = [...Net.nodes.values()].filter(N => N.edges.length >= 3 || N.ring);
  const hotAcc = nodes.filter(N => N.accidents > 0).sort((a, b) => b.accidents - a.accidents).slice(0, 3);
  const hotWait = nodes.filter(N => N.waitAvg > 8 && N.thr > 10).sort((a, b) => b.waitAvg - a.waitAvg).slice(0, 3);
  let html = '';
  const nm = N => N.town ? N.town.name : (CTL_NAMES[N.ctl] || 'Kreuzung');
  for (const N of hotAcc) html += `<div class="hot" data-x="${N.x}" data-y="${N.y}">💥 ${N.accidents} Unfälle · ${nm(N)}</div>`;
  for (const N of hotWait) html += `<div class="hot" data-x="${N.x}" data-y="${N.y}">⏳ Ø ${N.waitAvg.toFixed(0)} s Wartezeit · ${nm(N)}</div>`;
  $('hotspots').innerHTML = html || '<div class="muted">Keine Brennpunkte – gut so!</div>';
  $('hotspots').querySelectorAll('.hot').forEach(d => d.onclick = () => { View.cx = +d.dataset.x; View.cy = +d.dataset.y; View.scale = Math.max(View.scale, 1.2); });
  updateInfo();
}

function drawChart() {
  const cv = $('chart'), ctx = cv.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== w * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const H = Sim.history;
  ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) { ctx.beginPath(); ctx.moveTo(0, h * i / 4); ctx.lineTo(w, h * i / 4); ctx.stroke(); }
  if (H.length < 2) return;
  const n = 120, data = H.slice(-n);
  const xOf = i => (i / (n - 1)) * w;
  const maxV = Math.max(10, ...data.map(d => d.n));
  // Unfaelle als Balken
  ctx.fillStyle = 'rgba(231,76,60,0.85)';
  data.forEach((d, i) => { if (d.acc) ctx.fillRect(xOf(i) - 1.5, h - 4 - d.acc * 8, 3, d.acc * 8); });
  const line = (f, col) => {
    ctx.strokeStyle = col; ctx.lineWidth = 1.6; ctx.beginPath();
    data.forEach((d, i) => { const y = h - 3 - f(d) * (h - 8); i ? ctx.lineTo(xOf(i), y) : ctx.moveTo(xOf(i), y); });
    ctx.stroke();
  };
  line(d => d.n / maxV, '#5dade2');
  line(d => d.flow, '#2ecc71');
  line(d => d.jam, '#e67e22');
}

function updateInfo() {
  const el = $('info');
  const sel = View.selected;
  if (UI.tool !== 'info' || !sel) { el.classList.add('hidden'); return; }
  let html = '';
  if (sel.edge) {
    const e = sel.edge;
    if (!Net.edges.has(e.id)) { el.classList.add('hidden'); return; }
    const type = e.ring ? 'Kreisfahrbahn' : (Object.values(ROAD_PRESETS).find(p => p.nF === e.nF && p.nB === e.nB && p.speed === e.kmh) || { name: 'Eigene Straße' }).name;
    const lvl = e.level > 0 ? ' (Brücke)' : e.level < 0 ? ' (Tunnel)' : '';
    html += `<div class="ititle">${type}${lvl}</div>`;
    html += row('Spuren', e.nB ? `${e.nF} + ${e.nB}` : `${e.nF} (Einbahn)`);
    html += row('Tempolimit', e.kmh + ' km/h' + (e.curveV * 3.6 < e.kmh ? ` · Kurve max. ${Math.round(e.curveV * 3.6)}` : ''));
    html += row('Länge', Math.round(e.len) + ' m');
    for (const L of [e.linkF, e.linkB]) {
      if (!L) continue;
      const cnt = L.allLanes.reduce((s, l) => s + l.vehicles.length, 0);
      const cap = L.n * 1800;
      html += `<div class="isub">Richtung ${L.dir > 0 ? '→' : '←'} ${L.to.town ? L.to.town.name : ''}</div>`;
      html += row('Verkehrsstärke', Math.round(L.flow) + ' Fz/h');
      html += row('Auslastung', Math.round(L.flow / cap * 100) + ' %');
      html += row('Ø Tempo', Math.round(L.avgV * 3.6) + ' km/h');
      html += row('Fahrzeuge', cnt);
    }
    html += row('Unfälle', e.accidents);
  } else if (sel.node) {
    const N = sel.node;
    if (N.deleted) { el.classList.add('hidden'); return; }
    if (N.town) {
      const t = N.town;
      html += `<div class="ititle">🏘 ${t.name}</div>`;
      html += row('Einwohner', t.pop.toLocaleString('de-DE'));
      html += row('Losgefahren', t.sent);
      html += row('Angekommen', t.arrived);
      html += row('Warten', t.queue.length);
      html += row('Erreichbare Ziele', t.dests.length);
    } else {
      html += `<div class="ititle">Kreuzung · ${CTL_NAMES[N.ctl] || N.ctl}</div>`;
    }
    html += row('Zufahrten', N.inLinks.length);
    html += row('Durchsatz', Math.round(N.thr) + ' Fz/h');
    html += row('Ø Wartezeit', N.waitAvg.toFixed(1) + ' s');
    html += row('Unfälle', N.accidents);
  }
  el.innerHTML = html;
  el.classList.remove('hidden');
}
function row(a, b) { return `<div class="row"><span>${a}</span><b>${b}</b></div>`; }
