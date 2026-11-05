'use strict';
// ---------- Bedienung (Maus, Touch, Tastatur) ----------
const TOOLS = [
  { id: 'road', key: '1', icon: '🛣️', name: 'Straße', hint: 'Ziehen = Straße bauen · Zwei Finger / Rechtsklick-Ziehen = Karte bewegen' },
  { id: 'junction', key: '2', icon: '🚦', name: 'Kreuzung', hint: 'Kreuzung antippen: Vorfahrt, Stopp, Ampel, Grünpfeil, Kreisverkehr' },
  { id: 'lanes', key: '3', icon: '↱', name: 'Spuren', hint: 'Straße kurz vor einer Kreuzung antippen: Abbiegespuren & Richtungspfeile' },
  { id: 'upgrade', key: '4', icon: '🔧', name: 'Umbauen', hint: 'Straße antippen: bekommt den gewählten Straßentyp · Einbahnstraße erneut antippen = umdrehen' },
  { id: 'bulldoze', key: '5', icon: '🧨', name: 'Abriss', hint: 'Straße oder Kreuzung antippen zum Abreißen' },
  { id: 'info', key: '6', icon: '🔍', name: 'Info', hint: 'Straße, Kreuzung oder Ort antippen' },
];
const SPEEDS = [1, 2, 4, 8];
const UIInsets = { bottom: 90, top: 56 };

const UI = {
  tool: 'road', level: 0, preset: 'stadt', spec: Object.assign({}, ROAD_PRESETS.stadt),
  stage: 0, start: null, draw: null, pend: null, handleDrag: false,
  mouse: { x: 0, y: 0, sx: 0, sy: 0, has: false }, shift: false,
  pointers: new Map(), pinch: null, keys: new Set(), lastToast: 0, sheet: null, sheetArg: null,
};

const $ = (id) => document.getElementById(id);

// ---------- Verkehrszeichen als kleine SVGs ----------
const SIGN = {
  rvl: '<svg viewBox="0 0 40 36"><path d="M20 2 38 34H2Z" fill="#fff" stroke="#d0021b" stroke-width="4" stroke-linejoin="round"/><path d="M20 12v16M13 20h14" stroke="#111" stroke-width="3.4"/></svg>',
  auto: '<svg viewBox="0 0 40 40"><path d="M20 1 39 20 20 39 1 20Z" fill="#fff" stroke="#bbb"/><path d="M20 8 32 20 20 32 8 20Z" fill="#f5c400"/></svg>',
  yield: '<svg viewBox="0 0 40 36"><path d="M2 2H38L20 34Z" fill="#fff" stroke="#d0021b" stroke-width="4" stroke-linejoin="round"/></svg>',
  stop: '<svg viewBox="0 0 40 40"><path d="M13 2h14l11 11v14L27 38H13L2 27V13Z" fill="#d0021b" stroke="#fff" stroke-width="2"/><text x="20" y="25" font-size="11" font-weight="800" fill="#fff" text-anchor="middle" font-family="sans-serif">STOP</text></svg>',
  light: '<svg viewBox="0 0 24 40"><rect x="2" y="1" width="20" height="38" rx="4" fill="#222"/><circle cx="12" cy="9" r="5" fill="#ff3b30"/><circle cx="12" cy="20" r="5" fill="#ffcc00"/><circle cx="12" cy="31" r="5" fill="#34c759"/></svg>',
  gruen: '<svg viewBox="0 0 40 30"><rect width="40" height="30" rx="3" fill="#111"/><path d="M8 15h20M21 8l7 7-7 7" stroke="#2ecc71" stroke-width="4" fill="none" stroke-linecap="round"/></svg>',
  ring: '<svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="19" fill="#1f5fbf"/><circle cx="20" cy="20" r="9" fill="none" stroke="#fff" stroke-width="3.5"/><path d="M29 14l3 7-7-1" fill="#fff"/></svg>',
  major: '<svg viewBox="0 0 40 40"><path d="M20 1 39 20 20 39 1 20Z" fill="#fff" stroke="#bbb"/><path d="M20 8 32 20 20 32 8 20Z" fill="#f5c400"/><path d="M14 26 20 14 26 26" stroke="#111" stroke-width="2.5" fill="none"/></svg>',
};

function uiInit() {
  const dock = $('dock');
  for (const t of TOOLS) {
    const b = document.createElement('button');
    b.className = 'tool'; b.dataset.tool = t.id;
    b.innerHTML = `<span class="ic">${t.icon}</span><span class="lb">${t.name}</span>`;
    b.title = `${t.name} (${t.key})`;
    b.onclick = () => setTool(t.id);
    dock.appendChild(b);
  }
  $('playBtn').onclick = () => setPaused(!Sim.paused);
  $('speedBtn').onclick = () => { const i = SPEEDS.indexOf(Sim.speed); Sim.speed = SPEEDS[(i + 1) % SPEEDS.length]; setPaused(false); };
  $('flowBtn').onclick = () => { View.showFlow = !View.showFlow; $('flowBtn').classList.toggle('on', View.showFlow); toast(View.showFlow ? '🌈 Fluss-Ansicht: grün = frei, rot = Stau' : 'Fluss-Ansicht aus'); };
  $('menuBtn').onclick = () => toggleSheet('menu');
  $('statChip').onclick = () => toggleSheet('stats');
  $('sheetClose').onclick = closeSheet;
  $('helpClose').onclick = () => $('help').classList.add('hidden');

  const cv = View.canvas;
  cv.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
  cv.addEventListener('wheel', onWheel, { passive: false });
  cv.addEventListener('contextmenu', e => e.preventDefault());
  document.addEventListener('gesturestart', e => e.preventDefault());
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', e => { UI.keys.delete(e.key.toLowerCase()); if (e.key === 'Shift') UI.shift = false; });

  Sim.onAccident = (rec) => {
    const now = performance.now();
    if (now - UI.lastToast < 3000) return;
    UI.lastToast = now;
    toast('💥 Unfall – antippen zum Hinsehen', () => { View.cx = rec.x; View.cy = rec.y; View.scale = Math.max(View.scale, 1.5); });
  };
  setTool('road');
  setPaused(false);
}

function measureInsets() {
  const d = $('dock').getBoundingClientRect(), c = $('ctx').getBoundingClientRect();
  UIInsets.bottom = View.H - Math.min(d.top, c.height ? c.top : d.top) + 6;
  UIInsets.top = $('top').getBoundingClientRect().bottom;
}

function isRoadTool() { return UI.tool === 'road'; }

function setTool(id) {
  UI.tool = id;
  document.querySelectorAll('.tool').forEach(b => b.classList.toggle('on', b.dataset.tool === id));
  cancelBuild();
  View.hover = null; View.selected = null;
  if (UI.sheet && !['menu', 'stats', 'type'].includes(UI.sheet)) closeSheet();
  renderCtx();
}

function setPaused(p) {
  Sim.paused = p;
  $('playBtn').textContent = p ? '▶' : '⏸';
  $('playBtn').classList.toggle('on', p);
  $('speedBtn').textContent = Sim.speed + '×';
}

function specLabel(sp) {
  const named = Object.entries(ROAD_PRESETS).find(([, p]) => p.nF === sp.nF && p.nB === sp.nB && p.speed === sp.speed && (p.median || 0) === (sp.median || 0));
  const lanes = sp.nB ? `${sp.nF}+${sp.nB}` : `${sp.nF} ➡`;
  return (named ? named[1].name : 'Eigene Straße') + ` · ${lanes} · ${sp.speed}`;
}

// Kontextleiste ueber dem Dock
function renderCtx() {
  const el = $('ctx');
  const t = TOOLS.find(x => x.id === UI.tool);
  let html = '';
  if (UI.tool === 'road' || UI.tool === 'upgrade') {
    html += `<button id="typeChip" class="pill main">${specLabel(UI.spec)} ▾</button>`;
  }
  if (UI.tool === 'road') {
    html += `<div class="seg">${[[0, 'Boden'], [1, '🌉 Brücke'], [-1, '🚇 Tunnel']].map(([l, n]) => `<button data-level="${l}" class="${UI.level === l ? 'on' : ''}">${n}</button>`).join('')}</div>`;
  }
  if (UI.tool !== 'road') html += `<div class="hintTxt">${t.hint}</div>`;
  el.innerHTML = html;
  const tc = $('typeChip'); if (tc) tc.onclick = () => toggleSheet('type');
  el.querySelectorAll('[data-level]').forEach(b => b.onclick = () => { UI.level = +b.dataset.level; renderCtx(); });
  requestAnimationFrame(measureInsets);
}

function renderFloat() {
  const el = $('floatBtns');
  let html = '';
  if (UI.pend) html = `<button id="fbStraight" class="fb" title="Gerade machen">⟋</button><button id="fbCancel" class="fb">✕</button><button id="fbBuild" class="fb ok">✓ Bauen</button>`;
  else if (UI.stage === 1) html = `<button id="fbDone" class="fb">✓ Fertig</button>`;
  if (el.dataset.html === html) return;
  el.dataset.html = html;
  el.innerHTML = html;
  if ($('fbBuild')) $('fbBuild').onclick = buildPending;
  if ($('fbCancel')) $('fbCancel').onclick = cancelBuild;
  if ($('fbStraight')) $('fbStraight').onclick = () => { if (UI.pend) UI.pend.c = mid(UI.pend.s0, UI.pend.s1); };
  if ($('fbDone')) $('fbDone').onclick = cancelBuild;
}

function cancelBuild() { UI.stage = 0; UI.start = null; UI.draw = null; UI.pend = null; UI.handleDrag = false; View.preview = null; renderFloat(); }

function toast(msg, onClick) {
  const box = $('toast');
  while (box.children.length > 2) box.firstChild.remove();
  const t = document.createElement('div');
  t.className = 'toastItem'; t.textContent = msg;
  if (onClick) { t.classList.add('click'); t.onclick = () => { onClick(); t.remove(); }; }
  box.appendChild(t);
  setTimeout(() => t.classList.add('fade'), 2800);
  setTimeout(() => t.remove(), 3600);
}

// ---------- Zeiger ----------
function localXY(e) { const r = View.canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }

function onPointerDown(e) {
  if (e.target !== View.canvas) return;
  e.preventDefault();
  if (View.canvas.setPointerCapture) { try { View.canvas.setPointerCapture(e.pointerId); } catch (err) { /* egal */ } }
  const l = localXY(e);
  UI.pointers.set(e.pointerId, { x: l.x, y: l.y, sx: l.x, sy: l.y, button: e.button, moved: false, type: e.pointerType });
  if (UI.pointers.size === 2) {
    UI.draw = null; UI.handleDrag = false;
    const [a, b] = [...UI.pointers.values()];
    a.moved = b.moved = true;
    UI.pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
    return;
  }
  if (UI.pend && e.button === 0) {
    const h = w2s(UI.pend.c.x, UI.pend.c.y);
    if (Math.hypot(h.x - l.x, h.y - l.y) < (e.pointerType === 'mouse' ? 18 : 34)) UI.handleDrag = true;
  }
}

function onPointerMove(e) {
  const l = localXY(e);
  const p = UI.pointers.get(e.pointerId);
  const prev = p ? { x: p.x, y: p.y } : null;
  if (p) { p.x = l.x; p.y = l.y; }
  if (UI.pinch && UI.pointers.size >= 2) {
    const [a, b] = [...UI.pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y), mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    View.cx -= (mx - UI.pinch.mx) / View.scale; View.cy -= (my - UI.pinch.my) / View.scale;
    if (UI.pinch.d > 10) zoomAt(mx, my, d / UI.pinch.d);
    UI.pinch.d = d; UI.pinch.mx = mx; UI.pinch.my = my;
    return;
  }
  UI.mouse.sx = l.x; UI.mouse.sy = l.y;
  const w = s2w(l.x, l.y);
  UI.mouse.x = w.x; UI.mouse.y = w.y; UI.mouse.has = true;
  UI.shift = e.shiftKey;
  if (!p) { if (e.pointerType === 'mouse') updateHover(); return; }
  if (!p.moved && Math.hypot(l.x - p.sx, l.y - p.sy) > (p.type === 'mouse' ? 5 : 10)) {
    p.moved = true;
    if (!UI.handleDrag && !p.panOnly && isRoadTool() && p.button === 0 && !UI.pend) {
      const ws = s2w(p.sx, p.sy);
      UI.stage = 0; UI.start = null;
      UI.draw = { start: snapPoint(ws.x, ws.y, View.scale), end: null };
    }
  }
  if (!p.moved) return;
  if (UI.handleDrag) { UI.pend.c = { x: w.x, y: w.y }; return; }
  if (UI.draw) { UI.draw.end = currentSnap(UI.draw.start); return; }
  View.cx -= (l.x - prev.x) / View.scale; View.cy -= (l.y - prev.y) / View.scale;
  const w2 = s2w(l.x, l.y); UI.mouse.x = w2.x; UI.mouse.y = w2.y;
}

function onPointerUp(e) {
  const p = UI.pointers.get(e.pointerId);
  UI.pointers.delete(e.pointerId);
  if (UI.pinch) {
    if (UI.pointers.size < 2) {
      UI.pinch = null;
      // verbleibender Finger: nur noch verschieben, kein Bauen/Tippen
      for (const q of UI.pointers.values()) { q.moved = true; q.panOnly = true; }
    }
    return;
  }
  if (!p) return;
  if (UI.handleDrag) { UI.handleDrag = false; return; }
  if (UI.draw) { finishDraw(); return; }
  if (p.moved) return;
  if (p.button === 2) { cancelBuild(); return; }
  if (p.button !== 0) return;
  const w = s2w(p.sx, p.sy);
  UI.mouse.x = w.x; UI.mouse.y = w.y; UI.mouse.sx = p.sx; UI.mouse.sy = p.sy;
  onTap();
}

function zoomAt(sx, sy, f) {
  const before = s2w(sx, sy);
  View.scale = clamp(View.scale * f, 0.04, 8);
  const after = s2w(sx, sy);
  View.cx += before.x - after.x; View.cy += before.y - after.y;
}

function onWheel(e) {
  e.preventDefault();
  const l = localXY(e);
  zoomAt(l.x, l.y, Math.pow(1.0015, -e.deltaY));
}

function onKeyDown(e) {
  if (e.target && (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT')) return;
  const k = e.key.toLowerCase();
  UI.keys.add(k);
  if (e.key === 'Shift') UI.shift = true;
  const t = TOOLS.find(x => x.key === e.key);
  if (t) { setTool(t.id); return; }
  if (k === 'escape') { cancelBuild(); closeSheet(); $('help').classList.add('hidden'); }
  else if (k === 'b') { UI.level = UI.level === 0 ? 1 : UI.level === 1 ? -1 : 0; renderCtx(); }
  else if (k === ' ') { e.preventDefault(); setPaused(!Sim.paused); }
  else if (k === 'f') $('flowBtn').click();
  else if (k === 'enter' && UI.pend) buildPending();
  else if (k === '+' || k === '=') zoomAt(View.W / 2, View.H / 2, 1.25);
  else if (k === '-') zoomAt(View.W / 2, View.H / 2, 0.8);
}

function panKeys(dt) {
  const sp = 600 * dt / View.scale, K = UI.keys;
  if (K.has('w') || K.has('arrowup')) View.cy -= sp;
  if (K.has('s') || K.has('arrowdown')) View.cy += sp;
  if (K.has('a') || K.has('arrowleft')) View.cx -= sp;
  if (K.has('d') || K.has('arrowright')) View.cx += sp;
}

// ---------- Bauen ----------
function currentSnap(ref) {
  let sn = snapPoint(UI.mouse.x, UI.mouse.y, View.scale);
  if (sn.type === 'free' && UI.shift && ref) {
    const dx = sn.x - ref.x, dy = sn.y - ref.y, d = Math.hypot(dx, dy);
    const a = Math.round(Math.atan2(dy, dx) / (Math.PI / 12)) * (Math.PI / 12);
    sn = { type: 'free', x: ref.x + Math.cos(a) * d, y: ref.y + Math.sin(a) * d };
  }
  return sn;
}

function mid(a, b) { return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; }

// Gewuenschte Richtung an einem Strassenende, damit die Fortsetzung nahtlos (tangential) anschliesst
function endTangent(sn, isStart) {
  if (!sn || sn.type !== 'node' || !sn.node || sn.node.deleted || sn.node.edges.length !== 1) return null;
  const e = sn.node.edges[0];
  if (!e.tx) return null;
  const d = edgeDirAt(e, sn.node);
  return isStart ? { x: -d.x, y: -d.y } : { x: d.x, y: d.y };
}

function autoCtrl(s0, s1) {
  // Rampe an Autobahn/Bundesstrasse: tangential ein- bzw. ausfaedeln
  if (UI.spec.nB === 0 && !(UI.spec.median > 0)) {
    const g = rampGeom(s0, s1);
    if (g && g.ok) return rampCtrl(g);
  }
  const dx = s1.x - s0.x, dy = s1.y - s0.y, L = Math.hypot(dx, dy);
  if (L < 1) return mid(s0, s1);
  let t0 = endTangent(s0, true), t1 = endTangent(s1, false);
  if (t0 && (t0.x * dx + t0.y * dy) / L < 0.05) t0 = null;
  if (t1 && (t1.x * dx + t1.y * dy) / L < 0.05) t1 = null;
  if (t0 && t1) {
    const det = t0.x * t1.y - t0.y * t1.x;
    if (Math.abs(det) > 0.02) {
      const a = (dx * t1.y - dy * t1.x) / det, b = (t0.x * dy - t0.y * dx) / det;
      if (a > 0 && b > 0 && a < 1.5 * L && b < 1.5 * L) return { x: s0.x + t0.x * a, y: s0.y + t0.y * a };
    } else return mid(s0, s1);
  }
  if (t0) return { x: s0.x + t0.x * L * 0.5, y: s0.y + t0.y * L * 0.5 };
  if (t1) return { x: s1.x - t1.x * L * 0.5, y: s1.y - t1.y * L * 0.5 };
  return mid(s0, s1);
}

function updatePreview() {
  let p0, p1, c, s0, s1, handle = false;
  if (UI.pend) { p0 = s0 = UI.pend.s0; p1 = s1 = UI.pend.s1; c = UI.pend.c; handle = true; }
  else if (UI.draw && UI.draw.end) { p0 = s0 = UI.draw.start; p1 = s1 = UI.draw.end; c = autoCtrl(p0, p1); }
  else if (UI.stage === 1 && UI.mouse.has) { p0 = s0 = UI.start; p1 = s1 = currentSnap(UI.start); c = autoCtrl(p0, p1); }
  else { View.preview = null; return; }
  const len = Math.hypot(c.x - p0.x, c.y - p0.y) + Math.hypot(p1.x - c.x, p1.y - c.y);
  View.preview = { p0, c, p1, spec: UI.spec, level: UI.level, ok: len >= 10, snap0: s0, snap1: s1, handle, len };
}

function doBuild(s0, c, s1) {
  const res = buildRoad(s0, c, s1, UI.spec, UI.level);
  if (!res.ok) toast('⚠️ ' + res.msg);
  return res;
}

function finishDraw() {
  const d = UI.draw;
  UI.draw = null;
  if (!d.end) return;
  UI.pend = { s0: d.start, s1: d.end, c: autoCtrl(d.start, d.end) };
  renderFloat();
}

function buildPending() {
  const p = UI.pend;
  if (!p) return;
  UI.pend = null;
  const res = doBuild(p.s0, p.c, p.s1);
  if (res.ok && p.chain) { UI.start = { type: 'node', node: res.end, x: res.end.x, y: res.end.y }; UI.stage = 1; }
  renderFloat();
}

// ---------- Werkzeuge ----------
function pickApproach(x, y, r) {
  const pe = pickEdge(x, y, r, e => !e.ring);
  if (!pe) return null;
  const e = pe.edge;
  const nearB = pe.u > e.len / 2;
  const L = nearB ? e.linkF : e.linkB;
  return { edge: e, link: L, nearB };
}

function updateHover() {
  const x = UI.mouse.x, y = UI.mouse.y, r = Math.max(4, 12 / View.scale);
  View.hover = null;
  if (isRoadTool()) {
    if (UI.stage === 0 && !UI.pend) {
      const sn = snapPoint(x, y, View.scale);
      if (sn.type === 'node') View.hover = { node: sn.node, color: '#4fc3f7' };
    }
    return;
  }
  if (UI.tool === 'junction') {
    const N = pickNode(x, y, Math.max(r, 15));
    if (N && isJunction(N)) View.hover = { node: N };
  } else if (UI.tool === 'lanes') {
    const a = pickApproach(x, y, r);
    if (a && a.link) View.hover = { edge: a.edge, link: a.link };
  } else if (UI.tool === 'bulldoze') {
    const N = pickNode(x, y, r);
    if (N && N.edges.length >= 3) View.hover = { node: N, color: '#ff5252' };
    else { const pe = pickEdge(x, y, r); if (pe) View.hover = { edge: pe.edge, color: '#ff5252' }; }
  } else if (UI.tool === 'upgrade') {
    const pe = pickEdge(x, y, r);
    if (pe) View.hover = { edge: pe.edge, color: '#7CFC9A' };
  } else if (UI.tool === 'info') {
    const N = pickNode(x, y, r);
    if (N && isJunction(N)) View.hover = { node: N };
    else { const pe = pickEdge(x, y, r); if (pe) View.hover = { edge: pe.edge }; }
  }
}

function onTap() {
  const x = UI.mouse.x, y = UI.mouse.y;
  if (isRoadTool()) {
    if (UI.pend) { UI.pend.c = { x, y }; return; }
    const sn = currentSnap(UI.start);
    if (UI.stage === 0) { UI.start = sn; UI.stage = 1; renderFloat(); return; }
    UI.pend = { s0: UI.start, s1: sn, c: autoCtrl(UI.start, sn), chain: true }; UI.stage = 0; renderFloat();
    return;
  }
  updateHover();
  const h = View.hover;
  if (UI.tool === 'junction') {
    if (h && h.node) { View.selected = { node: h.node }; openSheet('junction', h.node); }
    else toast('Hier ist keine Kreuzung – tippe auf einen Knoten mit mind. 3 Straßen');
  } else if (UI.tool === 'lanes') {
    const a = pickApproach(x, y, Math.max(4, 12 / View.scale));
    if (!a) return;
    if (!a.link) { toast('Einbahnstraße – Zufahrt nur am anderen Ende'); return; }
    View.selected = { edge: a.edge, link: a.link };
    openSheet('lanes', a.link);
  } else if (UI.tool === 'upgrade') {
    if (h && h.edge) { upgradeEdge(h.edge, UI.spec); toast('🔧 ' + specLabel(UI.spec)); }
  } else if (UI.tool === 'bulldoze') {
    if (h && h.node) { removeNode(h.node); netRebuild(); }
    else if (h && h.edge) { removeEdge(h.edge); netRebuild(); }
    View.hover = null;
  } else if (UI.tool === 'info') {
    if (h) { View.selected = Object.assign({}, h); openSheet('info', View.selected); }
    else {
      const t = Terrain.townsInRect(x - 300, y - 300, x + 300, y + 300).find(t => Math.hypot(t.x - x, t.y - y) < Terrain.townRadius(t));
      if (t) openSheet('info', { town: t });
    }
  }
}

// ---------- Sheets ----------
function toggleSheet(kind, arg) { if (UI.sheet === kind) closeSheet(); else openSheet(kind, arg); }
function closeSheet() { UI.sheet = null; $('sheet').classList.add('hidden'); if (UI.tool !== 'info') View.selected = null; }
function openSheet(kind, arg) {
  UI.sheet = kind; UI.sheetArg = arg;
  $('sheet').classList.remove('hidden');
  renderSheet();
}

function renderSheet() {
  const k = UI.sheet, a = UI.sheetArg;
  const T = { type: 'Straßentyp', junction: 'Kreuzung', lanes: 'Spuren & Pfeile', info: 'Info', stats: 'Verkehrslage', menu: 'Menü' };
  $('sheetTitle').textContent = T[k] || '';
  const body = $('sheetBody');
  if (k === 'type') body.innerHTML = typeSheet();
  else if (k === 'junction') body.innerHTML = junctionSheet(a);
  else if (k === 'lanes') body.innerHTML = lanesSheet(a);
  else if (k === 'info') body.innerHTML = infoSheet(a);
  else if (k === 'stats') body.innerHTML = statsSheet();
  else if (k === 'menu') body.innerHTML = menuSheet();
  wireSheet(k, a);
}

function stepper(id, label, val, sub) {
  return `<div class="stepRow"><span>${label}${sub ? `<small>${sub}</small>` : ''}</span><button data-step="${id}" data-d="-1" aria-label="weniger">−</button><b>${val}</b><button data-step="${id}" data-d="1" aria-label="mehr">+</button></div>`;
}

function typeSheet() {
  const sp = UI.spec;
  let h = '<div class="grid2">';
  for (const [k, p] of Object.entries(ROAD_PRESETS)) {
    const on = p.nF === sp.nF && p.nB === sp.nB && p.speed === sp.speed && (p.median || 0) === (sp.median || 0);
    h += `<button class="opt ${on ? 'on' : ''}" data-preset="${k}"><b>${p.name}</b><small>${p.nB ? p.nF + '+' + p.nB + ' Spuren' : p.nF + ' Spur einbahn'} · ${p.speed} km/h</small></button>`;
  }
  h += '</div><div class="sub">Eigene Einstellungen</div>';
  h += stepper('nF', 'Spuren →', sp.nF) + stepper('nB', 'Spuren ← (0 = Einbahn)', sp.nB);
  h += '<div class="chips">' + [30, 50, 70, 80, 100, 120, 130].map(v => `<button class="pill ${sp.speed === v ? 'on' : ''}" data-kmh="${v}"><span class="kmh">${v}</span></button>`).join('') + '</div>';
  h += `<label class="toggleRow"><input type="checkbox" id="medianChk" ${sp.median ? 'checked' : ''} ${sp.nB ? '' : 'disabled'}> Mittelstreifen (keine Grundstückszufahrten)</label>`;
  return h;
}

function ctlOption(key, icon, title, desc, on) {
  return `<button class="opt row ${on ? 'on' : ''}" data-ctl="${key}"><span class="sg">${icon}</span><span><b>${title}</b><small>${desc}</small></span></button>`;
}

function junctionSheet(N) {
  if (!N || N.deleted) return '<p class="muted">Kreuzung existiert nicht mehr.</p>';
  let h = '';
  if (N.ring) {
    h += `<p><span class="sg inline">${SIGN.ring}</span> Kreisverkehr – Einfahrende achten die Vorfahrt des Kreisverkehrs.</p>`;
  } else {
    h += ctlOption('rvl', SIGN.rvl, 'Rechts vor links', 'Keine Schilder – wer von rechts kommt, hat Vorfahrt', N.ctl === 'rvl');
    h += ctlOption('auto', SIGN.major + SIGN.yield, 'Vorfahrtstraße', 'Hauptstraße hat Vorfahrt, Nebenstraßen „Vorfahrt gewähren“', N.ctl === 'auto');
    h += ctlOption('stop', SIGN.major + SIGN.stop, 'Stoppschild', 'Nebenstraßen müssen anhalten', N.ctl === 'stop');
    h += ctlOption('light', SIGN.light, 'Ampel', 'Passt sich dem Verkehr an (Zeitlücken-Steuerung)', N.ctl === 'light');
    if (N.ctl === 'light') h += `<label class="toggleRow"><input type="checkbox" id="gruenChk" ${N.gruen ? 'checked' : ''}> <span class="sg inline">${SIGN.gruen}</span> Grünpfeil (rechts abbiegen bei Rot nach Halt)</label>`;
    if ((N.ctl === 'auto' || N.ctl === 'stop') && N.majorCount > 1) h += `<button class="opt row" data-act="major"><span class="sg">🔀</span><span><b>Hauptstraße ändern</b><small>Auch abknickende Vorfahrt möglich (${N.majorPick % N.majorCount + 1}/${N.majorCount})</small></span></button>`;
    h += `<button class="opt row" data-act="ring"><span class="sg">${SIGN.ring}</span><span><b>Zum Kreisverkehr umbauen</b><small>Sicher und flüssig bei mittlerem Verkehr</small></span></button>`;
  }
  h += `<div class="statLine">Durchsatz ${Math.round(N.thr)} Fz/h · Ø Wartezeit ${N.waitAvg.toFixed(1)} s · Unfälle ${N.accidents}</div>`;
  return h;
}

const ARROW_BTNS = [[ARR_L, '↰', 'links'], [ARR_S, '↑', 'geradeaus'], [ARR_R, '↱', 'rechts']];
function lanesSheet(L) {
  if (!L || L.dead) return '<p class="muted">Diese Zufahrt existiert nicht mehr.</p>';
  const e = L.edge, f = L.dir > 0;
  const tl = f ? e.tlF : e.tlB, tr = f ? e.trF : e.trB;
  const N = L.to;
  let h = `<p class="muted">Zufahrt zur ${isJunction(N) ? 'Kreuzung' : 'Einmündung'} (blau markiert). Änderungen gelten sofort.</p>`;
  h += stepper('n', 'Fahrstreifen', L.n);
  h += stepper('tl', 'Linksabbiegespuren', tl, 'zusätzlich, vor der Kreuzung');
  h += stepper('tr', 'Rechtsabbiegespur', tr, 'zusätzlich, vor der Kreuzung');
  if ((tl + tr) > 0 && !(f ? e.okF : e.okB)) h += '<p class="warn">Straße zu kurz für Abbiegespuren – mind. ca. 70 m zwischen den Kreuzungen nötig.</p>';
  if (isJunction(N) && L.outKinds) {
    const lanes = L.allLanes.slice().reverse(); // links -> rechts wie aus Fahrersicht
    h += '<div class="sub">Richtungspfeile je Fahrstreifen</div><div class="laneGrid">';
    for (const ln of lanes) {
      h += `<div class="laneCol ${ln.kind !== 'N' ? 'turn' : ''}">`;
      for (const [bit, sym, name] of ARROW_BTNS) {
        if (!(L.outKinds & bit)) continue;
        h += `<button class="arr ${ln.arrowMask & bit ? 'on' : ''}" data-slot="${ln.slot}" data-bit="${bit}" aria-label="${name}">${sym}</button>`;
      }
      h += `<small>${ln.kind === 'L' ? 'Abbieger' : ln.kind === 'R' ? 'Abbieger' : 'Spur'}</small></div>`;
    }
    h += '</div>';
    h += `<button class="pill" id="arrAuto">↺ Pfeile automatisch</button>`;
    h += '<p class="muted small">Ohne Pfeil in eine Richtung = Abbiegen verboten. Mehrere Spuren in dieselbe Richtung erlauben paralleles Abbiegen.</p>';
  } else h += '<p class="muted small">Richtungspfeile gibt es nur an Kreuzungen mit mindestens drei Straßen.</p>';
  return h;
}

function infoSheet(sel) {
  if (!sel) return '';
  const row = (a, b) => `<div class="row"><span>${a}</span><b>${b}</b></div>`;
  let h = '';
  if (sel.town) {
    const t = sel.town, hs = t.houses || [];
    h += `<div class="ititle">🏘 ${t.name}</div>` + row('Einwohner', t.pop.toLocaleString('de-DE')) +
      row('Gebäude', hs.filter(x => !x.gone).length) + row('Angebunden', t.nAtt || 0) +
      '<p class="muted small">Häuser bis ca. 25 m neben einer Straße bekommen automatisch eine Zufahrt. Autobahnen und Straßen mit Mittelstreifen haben keine Zufahrten.</p>';
    return h;
  }
  if (sel.edge) {
    const e = sel.edge;
    if (!Net.edges.has(e.id)) return '<p class="muted">Straße existiert nicht mehr.</p>';
    const lvl = e.level > 0 ? ' (Brücke)' : e.level < 0 ? ' (Tunnel)' : '';
    h += `<div class="ititle">${e.ring ? 'Kreisfahrbahn' : specLabel({ nF: e.nF, nB: e.nB, speed: e.kmh, median: e.median })}${lvl}</div>`;
    h += row('Länge', Math.round(e.len) + ' m');
    if (e.curveV * 3.6 < e.kmh) h += row('Kurve', `max. ${Math.round(e.curveV * 3.6)} km/h fahrbar`);
    for (const L of [e.linkF, e.linkB]) {
      if (!L) continue;
      h += `<div class="sub">Richtung ${L.dir > 0 ? '→' : '←'}</div>`;
      h += row('Verkehrsstärke', Math.round(L.flow) + ' Fz/h') + row('Auslastung', Math.round(L.flow / (L.n * 1800) * 100) + ' %') + row('Ø Tempo', Math.round(L.avgV * 3.6) + ' km/h');
    }
    h += row('Unfälle', e.accidents);
  } else if (sel.node) {
    const N = sel.node;
    if (N.deleted) return '';
    const CTL = { rvl: 'Rechts vor links', auto: 'Vorfahrtstraße', stop: 'Stoppschild', light: N.gruen ? 'Ampel mit Grünpfeil' : 'Ampel', ringnode: 'Kreisverkehr' };
    h += `<div class="ititle">Kreuzung · ${CTL[N.ctl] || '–'}</div>` + row('Zufahrten', N.inLinks.length) + row('Durchsatz', Math.round(N.thr) + ' Fz/h') + row('Ø Wartezeit', N.waitAvg.toFixed(1) + ' s') + row('Unfälle', N.accidents);
  }
  return h;
}

function statsRows() {
  const st = Sim.stats, R = simRating();
  const active = Sim.vehicles.filter(v => !v.dead).length;
  const cls = (good, mid) => good ? 'good' : mid ? 'mid' : 'bad';
  return [
    ['Unterwegs', active],
    ['Verkehrsfluss', Math.round(Sim.flowIdx * 100) + ' %', cls(Sim.flowIdx > 0.7, Sim.flowIdx > 0.45)],
    ['Stau-Anteil', Math.round(Sim.jam * 100) + ' %', cls(Sim.jam < 0.15, Sim.jam < 0.35)],
    ['Fahrten', st.trips.toLocaleString('de-DE')],
    ['Durchsatz', Math.round(R.tripsPerH).toLocaleString('de-DE') + ' Fz/h'],
    ['Unfälle', st.accidents + (R.accWin ? ` (${R.accWin} in 10 min)` : ''), cls(R.accRate < 2, R.accRate < 8)],
    ['Warten auf Ausfahrt', Sim.pending.length, cls(Sim.pending.length < 20, Sim.pending.length < 80)],
    ['Angebundene Gebäude', Sim.dests.length],
  ];
}

function statsSheet() {
  const R = simRating();
  let h = `<div class="gradeRow"><div class="grade big" style="background:${gradeColor()}">${gradeText()}</div><div><b>Verkehrsnote</b><div class="muted small">${Sim.dests.length < 2 ? 'Baue Straßen an Häusern vorbei, damit Verkehr entsteht.' : Math.round(R.score) + ' von 100 Punkten'}</div></div></div>`;
  h += '<div id="statRows">' + statsRows().map(r => `<div class="row"><span>${r[0]}</span><b class="${r[2] || ''}">${r[1]}</b></div>`).join('') + '</div>';
  h += '<canvas id="chart"></canvas><div class="legend"><span class="c1">● Fahrzeuge</span><span class="c2">● Fluss</span><span class="c3">● Stau</span><span class="c4">▮ Unfälle</span></div>';
  h += '<div class="sub">Brennpunkte</div><div id="hotspots">' + hotspotsHtml() + '</div>';
  return h;
}

function hotspotsHtml() {
  const nodes = [...Net.nodes.values()].filter(isJunction);
  const items = [];
  for (const N of nodes.filter(N => N.accidents > 0).sort((a, b) => b.accidents - a.accidents).slice(0, 3)) items.push(`<button class="hot" data-x="${N.x}" data-y="${N.y}">💥 ${N.accidents} Unfälle an einer Kreuzung</button>`);
  for (const N of nodes.filter(N => N.waitAvg > 8 && N.thr > 10).sort((a, b) => b.waitAvg - a.waitAvg).slice(0, 3)) items.push(`<button class="hot" data-x="${N.x}" data-y="${N.y}">⏳ Ø ${N.waitAvg.toFixed(0)} s Wartezeit</button>`);
  return items.join('') || '<p class="muted small">Keine Brennpunkte.</p>';
}

function menuSheet() {
  return `<div class="sub">Verkehr</div>
    <label class="sliderRow">Verkehrsaufkommen <input type="range" id="demand" min="0" max="3" step="0.05" value="${Sim.demand}"><b id="demandVal">${Math.round(Sim.demand * 100)} %</b></label>
    <label class="sliderRow">Fahrfehler <select id="errSel">${[[0, 'aus'], [0.5, 'selten'], [1, 'normal'], [2.5, 'häufig']].map(([v, n]) => `<option value="${v}" ${Sim.errMul === v ? 'selected' : ''}>${n}</option>`).join('')}</select></label>
    <label class="toggleRow"><input type="checkbox" id="accChk" ${View.showAcc ? 'checked' : ''}> Unfallorte auf der Karte zeigen</label>
    <div class="sub">Spielstand</div>
    <div class="chips"><button class="pill" id="saveBtn">💾 Speichern</button><button class="pill" id="loadBtn">📂 Laden</button><button class="pill" id="helpBtn">❓ Hilfe</button></div>
    <div class="sub">Neue Welt</div>
    <div class="chips"><input id="seedInput" type="number" min="1" value="${Math.floor(Math.random() * 1e6) + 1}" aria-label="Seed"><button class="pill warnBtn" id="seedGo">🌍 Erzeugen</button></div>
    <p class="muted small">Der gleiche Seed erzeugt die gleiche Landschaft. Das aktuelle Straßennetz wird dabei verworfen.</p>`;
}

function wireSheet(k, a) {
  const body = $('sheetBody');
  body.querySelectorAll('[data-preset]').forEach(b => b.onclick = () => {
    UI.spec = Object.assign({}, ROAD_PRESETS[b.dataset.preset]); renderSheet(); renderCtx();
    if (UI.spec.median > 0) toast('Kreuzungsfrei: Querende Straßen werden überbrückt, Anschluss nur über Auf-/Abfahrt');
    else if (b.dataset.preset === 'rampe') toast('Auf-/Abfahrt an Autobahn oder Bundesstraße ansetzen – Ein-/Ausfädelungsstreifen entstehen automatisch');
  });
  body.querySelectorAll('[data-kmh]').forEach(b => b.onclick = () => { UI.spec.speed = +b.dataset.kmh; renderSheet(); renderCtx(); });
  const mc = $('medianChk'); if (mc) mc.onchange = () => { UI.spec.median = mc.checked && UI.spec.nB ? 3 : 0; renderSheet(); renderCtx(); };
  body.querySelectorAll('[data-step]').forEach(b => b.onclick = () => {
    const id = b.dataset.step, d = +b.dataset.d;
    if (k === 'type') {
      if (id === 'nF') UI.spec.nF = clamp(UI.spec.nF + d, 1, 4);
      if (id === 'nB') { UI.spec.nB = clamp(UI.spec.nB + d, 0, 4); if (!UI.spec.nB) UI.spec.median = 0; }
      renderCtx();
    } else if (k === 'lanes') {
      const L = a, e = L.edge, f = L.dir > 0;
      const cur = { n: L.n, tl: f ? e.tlF : e.tlB, tr: f ? e.trF : e.trB }[id];
      setApproach(L, { [id]: cur + d });
      const nl = f ? e.linkF : e.linkB;
      if (nl) { UI.sheetArg = nl; View.selected = { edge: e, link: nl }; }
    }
    renderSheet();
  });
  body.querySelectorAll('[data-ctl]').forEach(b => b.onclick = () => { setNodeControl(a, b.dataset.ctl); renderSheet(); });
  const gc = $('gruenChk'); if (gc) gc.onchange = () => { a.gruen = gc.checked; toast(gc.checked ? 'Grünpfeil angebracht' : 'Grünpfeil entfernt'); };
  body.querySelectorAll('[data-act]').forEach(b => b.onclick = () => {
    if (b.dataset.act === 'major') { a.majorPick = (a.majorPick + 1) % (a.majorCount || 1); Net.dirty.add(a); netRebuild(); renderSheet(); }
    if (b.dataset.act === 'ring') { const r = buildRoundabout(a); toast(r.ok ? '⭕ Kreisverkehr gebaut' : '⚠️ ' + r.msg); if (r.ok) closeSheet(); }
  });
  body.querySelectorAll('.arr').forEach(b => b.onclick = () => {
    const L = a, slot = +b.dataset.slot, bit = +b.dataset.bit;
    const masks = L.allLanes.map(ln => ln.arrowMask);
    masks[slot] ^= bit;
    if (!masks[slot]) { toast('Jede Spur braucht mindestens einen Pfeil'); return; }
    setApproach(L, { arr: masks });
    renderSheet();
  });
  const aa = $('arrAuto'); if (aa) aa.onclick = () => { setApproach(a, { arr: null }); renderSheet(); };
  body.querySelectorAll('.hot').forEach(d => d.onclick = () => { View.cx = +d.dataset.x; View.cy = +d.dataset.y; View.scale = Math.max(View.scale, 1.4); closeSheet(); });
  if (k === 'stats') drawChart();
  if (k === 'menu') {
    $('demand').oninput = (ev) => { Sim.demand = +ev.target.value; $('demandVal').textContent = Math.round(Sim.demand * 100) + ' %'; };
    $('errSel').onchange = (ev) => { Sim.errMul = +ev.target.value; };
    $('accChk').onchange = (ev) => { View.showAcc = ev.target.checked; };
    $('saveBtn').onclick = () => toast(saveGame() ? '💾 Gespeichert' : 'Speichern nicht möglich');
    $('loadBtn').onclick = () => { if (loadGame()) { toast('📂 Spielstand geladen'); closeSheet(); } else toast('Kein Spielstand gefunden'); };
    $('helpBtn').onclick = () => { closeSheet(); $('help').classList.remove('hidden'); };
    $('seedGo').onclick = () => { newWorld(Math.abs(parseInt($('seedInput').value, 10)) || 1); closeSheet(); toast('🌍 Neue Welt erzeugt'); };
  }
}

// Periodische Aktualisierung
function gradeText() { const R = simRating(); return (Sim.history.length >= 6 && Sim.vehicles.length > 5) ? R.grade : '–'; }
function gradeColor() {
  const g = gradeText();
  return { A: '#2ecc71', B: '#8bd346', C: '#f1c40f', D: '#e67e22', E: '#e74c3c', F: '#b71c1c' }[g] || '#566';
}

function updatePanels() {
  const active = Sim.vehicles.filter(v => !v.dead).length;
  $('grade').textContent = gradeText();
  $('grade').style.background = gradeColor();
  $('chipVeh').textContent = '🚗 ' + active;
  $('chipFlow').textContent = '🌊 ' + Math.round(Sim.flowIdx * 100) + '%';
  $('chipAcc').textContent = '💥 ' + Sim.stats.accidents;
  if (UI.sheet === 'stats') {
    const rows = $('statRows');
    if (rows) rows.innerHTML = statsRows().map(r => `<div class="row"><span>${r[0]}</span><b class="${r[2] || ''}">${r[1]}</b></div>`).join('');
    drawChart();
  } else if (UI.sheet === 'info') renderSheet();
  renderFloat();
}

function drawChart() {
  const cv = $('chart');
  if (!cv) return;
  const ctx = cv.getContext('2d');
  const dpr = window.devicePixelRatio || 1;
  const w = cv.clientWidth, h = cv.clientHeight;
  if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.strokeStyle = 'rgba(255,255,255,0.08)'; ctx.lineWidth = 1;
  for (let i = 1; i < 4; i++) { ctx.beginPath(); ctx.moveTo(0, h * i / 4); ctx.lineTo(w, h * i / 4); ctx.stroke(); }
  const data = Sim.history.slice(-120);
  if (data.length < 2) return;
  const xOf = i => (i / 119) * w;
  const maxV = Math.max(10, ...data.map(d => d.n));
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
