'use strict';
// ---------- Darstellung ----------
const View = {
  cx: 0, cy: 0, scale: 1.2, W: 800, H: 600, dpr: 1, canvas: null, ctx: null,
  showFlow: false, showAcc: true, hover: null, preview: null, selected: null, frame: 0,
};

const COL = {
  asphalt: '#4b4e54', asphaltLight: '#55585e', bridge: '#767a82', bridgeEdge: '#d6d8dc', mark: '#f2f2f2',
  markYellow: '#f4d03f', island: '#78a957', shadow: 'rgba(0,0,0,0.28)',
};

function s2w(sx, sy) { return { x: (sx - View.W / 2) / View.scale + View.cx, y: (sy - View.H / 2) / View.scale + View.cy }; }
function w2s(x, y) { return { x: (x - View.cx) * View.scale + View.W / 2, y: (y - View.cy) * View.scale + View.H / 2 }; }

function setWorldTf(ctx) {
  const k = View.dpr * View.scale;
  ctx.setTransform(k, 0, 0, k, View.dpr * (View.W / 2 - View.cx * View.scale), View.dpr * (View.H / 2 - View.cy * View.scale));
}

function viewRect(pad) {
  const s = View.scale; pad = pad || 0;
  return { x0: View.cx - View.W / 2 / s - pad, y0: View.cy - View.H / 2 / s - pad, x1: View.cx + View.W / 2 / s + pad, y1: View.cy + View.H / 2 / s + pad };
}
function bbIn(bb, r, pad) { return !(bb.x1 < r.x0 - pad || bb.x0 > r.x1 + pad || bb.y1 < r.y0 - pad || bb.y0 > r.y1 + pad); }

// ---------- Gelaende ----------
function drawTerrain(ctx, r) {
  const s = View.scale;
  const lod = s >= 0.2 ? 0 : s >= 0.06 ? 1 : 2;
  const { size } = CHUNK_LODS[lod];
  const c0 = Math.floor(r.x0 / size), c1 = Math.floor(r.x1 / size);
  const r0 = Math.floor(r.y0 / size), r1 = Math.floor(r.y1 / size);
  const t0 = performance.now();
  ctx.imageSmoothingEnabled = true;
  const ov = 1 / s;
  // von innen nach aussen generieren
  const list = [];
  const mx = (c0 + c1) / 2, my = (r0 + r1) / 2;
  for (let cy = r0; cy <= r1; cy++) for (let cx = c0; cx <= c1; cx++) list.push([cx, cy, (cx - mx) ** 2 + (cy - my) ** 2]);
  list.sort((a, b) => a[2] - b[2]);
  for (const [cx, cy] of list) {
    const allow = performance.now() - t0 < 9;
    let ch = Terrain.getChunk(lod, cx, cy, allow);
    if (ch) { ctx.drawImage(ch.cv, ch.x0, ch.y0, size + ov, size + ov); continue; }
    // Fallback: groebere Stufe
    let drawn = false;
    for (let l2 = lod + 1; l2 < CHUNK_LODS.length && !drawn; l2++) {
      const S2 = CHUNK_LODS[l2].size, res = CHUNK_LODS[l2].res;
      const px = Math.floor(cx * size / S2), py = Math.floor(cy * size / S2);
      const p = Terrain.getChunk(l2, px, py, false);
      if (p) {
        const f = res / S2;
        const sx = (cx * size - px * S2) * f, sy = (cy * size - py * S2) * f;
        ctx.drawImage(p.cv, sx, sy, size * f, size * f, cx * size, cy * size, size + ov, size + ov);
        drawn = true;
      }
    }
    if (!drawn) { ctx.fillStyle = '#7ea65a'; ctx.fillRect(cx * size, cy * size, size + ov, size + ov); }
  }
}

function drawTowns(ctx, r, towns) {
  const s = View.scale;
  for (const t of towns) {
    const R = Terrain.townRadius(t);
    if (t.x + R < r.x0 || t.x - R > r.x1 || t.y + R < r.y0 || t.y - R > r.y1) continue;
    if (s < 0.22) {
      ctx.fillStyle = 'rgba(150,120,100,0.55)';
      ctx.beginPath(); ctx.arc(t.x, t.y, R * 0.8, 0, TAU); ctx.fill();
      continue;
    }
    ctx.fillStyle = 'rgba(190,180,160,0.35)';
    ctx.beginPath(); ctx.arc(t.x, t.y, R * 0.9, 0, TAU); ctx.fill();
    for (const h of Terrain.townHouses(t)) {
      ctx.save();
      ctx.translate(h.x, h.y); ctx.rotate(h.a);
      ctx.fillStyle = 'rgba(0,0,0,0.22)'; ctx.fillRect(-h.w / 2 + 1, -h.h / 2 + 1, h.w, h.h);
      ctx.fillStyle = h.roof; ctx.fillRect(-h.w / 2, -h.h / 2, h.w, h.h);
      if (s > 0.8) { ctx.fillStyle = 'rgba(0,0,0,0.15)'; ctx.fillRect(-h.w / 2, 0, h.w, h.h / 2); }
      ctx.restore();
    }
    ctx.fillStyle = '#c9c1b0';
    ctx.beginPath(); ctx.arc(t.x, t.y, 9, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#8c8475'; ctx.lineWidth = 0.8; ctx.stroke();
  }
}

// ---------- Strassen ----------
function roadPath(ctx, e, i0, i1, ext) {
  ext = ext || 0;
  ctx.beginPath();
  for (let i = i0; i <= i1; i++) {
    const u = i * e.step, R = edgeRight(e, u) + ext;
    const x = e.px[i] - e.ty[i] * R, y = e.py[i] + e.tx[i] * R;
    if (i === i0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  for (let i = i1; i >= i0; i--) {
    const u = i * e.step, Lf = edgeLeft(e, u) + ext;
    ctx.lineTo(e.px[i] + e.ty[i] * Lf, e.py[i] - e.tx[i] * Lf);
  }
  ctx.closePath();
}

function latLine(ctx, e, latFn, u0, u1) {
  const st = e.step;
  const i0 = Math.ceil(u0 / st), i1 = Math.floor(u1 / st);
  ctx.beginPath();
  let first = true;
  const pt = (u) => {
    const p = edgeSample(e, u), l = latFn(u);
    const x = p.x - p.ty * l, y = p.y + p.tx * l;
    if (first) { ctx.moveTo(x, y); first = false; } else ctx.lineTo(x, y);
  };
  pt(u0);
  for (let i = i0; i <= i1; i++) pt(i * st);
  pt(u1);
  ctx.stroke();
}

function runs(arr, n) {
  const out = [];
  let st = -1;
  for (let i = 0; i <= n; i++) {
    if (arr[i]) { if (st < 0) st = i; }
    else if (st >= 0) { out.push([Math.max(0, st - 1), i]); st = -1; }
  }
  if (st >= 0) out.push([Math.max(0, st - 1), n]);
  return out;
}

function nodePoly(ctx, N) {
  const pts = [];
  for (const e of N.edges) {
    const atA = e.A === N;
    const u = atA ? e.trimA : e.len - e.trimB;
    const p = edgeSample(e, u, {});
    const R = edgeRight(e, u), Lf = edgeLeft(e, u);
    pts.push({ x: p.x - p.ty * R, y: p.y + p.tx * R });
    pts.push({ x: p.x + p.ty * Lf, y: p.y - p.tx * Lf });
  }
  if (pts.length < 3) return false;
  let cx = 0, cy = 0;
  for (const p of pts) { cx += p.x; cy += p.y; }
  cx /= pts.length; cy /= pts.length;
  pts.sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx));
  ctx.beginPath();
  pts.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
  return true;
}

function drawEdgeSurface(ctx, e, style) {
  const s = View.scale;
  if (s < 0.12) {
    ctx.strokeStyle = style; ctx.lineWidth = Math.max(e.hw * 2, 2.2 / s);
    ctx.beginPath();
    for (let i = 0; i <= e.n; i += 2) (i ? ctx.lineTo(e.px[i], e.py[i]) : ctx.moveTo(e.px[i], e.py[i]));
    ctx.lineTo(e.px[e.n], e.py[e.n]);
    ctx.stroke();
    return;
  }
  ctx.fillStyle = style;
  roadPath(ctx, e, 0, e.n, 0);
  ctx.fill();
}

function drawMarkings(ctx, e) {
  const s = View.scale;
  if (s < 0.55) return;
  const W = LANE_W, c = e.c0, m = e.median / 2;
  const u0 = e.trimA, u1 = e.len - e.trimB;
  if (u1 - u0 < 1) return;
  ctx.strokeStyle = COL.mark;
  ctx.lineWidth = 0.15;
  // Randlinien
  if (s > 1 && !e.ring) {
    ctx.setLineDash([]);
    latLine(ctx, e, u => edgeRight(e, u) - 0.35, u0, u1);
    latLine(ctx, e, u => -(edgeLeft(e, u) - 0.35), u0, u1);
  }
  // Spurtrenner
  ctx.setLineDash([3, 6]);
  for (let i = 1; i < e.nF; i++) latLine(ctx, e, u => c + m + (e.nF - i) * W + zoneB(e, u) * W, u0, u1);
  for (let i = 1; i < e.nB; i++) latLine(ctx, e, u => -(-c + m + (e.nB - i) * W + zoneF(e, u) * W), u0, u1);
  // Abbiegespuren
  ctx.setLineDash([1.5, 1.5]);
  if (e.turnOkF) { const zs = u1 - TURN_LEN; latLine(ctx, e, u => c + m + zoneB(e, u) * W, zs - 2, u1); }
  if (e.turnOkB) { const ze = u0 + TURN_LEN; latLine(ctx, e, u => -(-c + m + zoneF(e, u) * W), u0, ze + 2); }
  // Mittellinie / Mittelstreifen
  if (e.nB > 0) {
    const ctr = u => c + (zoneB(e, u) - zoneF(e, u)) * W;
    if (m > 0) {
      ctx.setLineDash([]);
      ctx.strokeStyle = '#6f8f55'; ctx.lineWidth = e.median - 0.4;
      latLine(ctx, e, ctr, u0, u1);
      ctx.strokeStyle = COL.mark; ctx.lineWidth = 0.15;
      latLine(ctx, e, u => ctr(u) - m + 0.1, u0, u1);
      latLine(ctx, e, u => ctr(u) + m - 0.1, u0, u1);
    } else {
      if (e.nF + e.nB <= 2 && !e.turnOkF && !e.turnOkB) ctx.setLineDash([4, 5]); else ctx.setLineDash([]);
      ctx.lineWidth = e.nF + e.nB > 2 ? 0.3 : 0.15;
      latLine(ctx, e, ctr, u0, u1);
    }
  }
  ctx.setLineDash([]);
  // Pfeile auf Abbiegespuren
  if (s > 1.4) {
    for (const L of [e.linkF, e.linkB]) {
      if (!L || !L.turnLane) continue;
      const p = lanePos(L.turnLane, L.turnLane.s1 - 8, 0, {});
      drawArrow(ctx, p.x, p.y, p.hx, p.hy, -1);
    }
  }
}

function drawArrow(ctx, x, y, hx, hy, turn) {
  ctx.save();
  ctx.translate(x, y); ctx.transform(hx, hy, -hy, hx, 0, 0);
  ctx.strokeStyle = COL.mark; ctx.lineWidth = 0.3;
  ctx.beginPath();
  ctx.moveTo(-2.5, 0); ctx.lineTo(0.5, 0);
  ctx.quadraticCurveTo(1.6, 0, 1.6, -1.1 * Math.sign(-turn));
  ctx.stroke();
  ctx.fillStyle = COL.mark;
  ctx.beginPath();
  const sy = -1.1 * Math.sign(-turn);
  ctx.moveTo(1.0, sy); ctx.lineTo(2.2, sy); ctx.lineTo(1.6, sy * 1.7);
  ctx.fill();
  ctx.restore();
}

function drawBridgeDeck(ctx, e, i0, i1) {
  ctx.fillStyle = COL.shadow;
  ctx.save(); ctx.translate(2.2, 3.2);
  roadPath(ctx, e, i0, i1, 1.2); ctx.fill();
  ctx.restore();
  ctx.fillStyle = COL.bridgeEdge;
  roadPath(ctx, e, i0, i1, 1.0); ctx.fill();
  ctx.fillStyle = COL.bridge;
  roadPath(ctx, e, i0, i1, 0.4); ctx.fill();
}

function drawStopLines(ctx, N) {
  const s = View.scale;
  if (s < 0.45 || (N.edges.length < 3 && !N.ring)) return;
  for (const L of N.inLinks) {
    const rank = N.rank.get(L);
    let style = null, dash = null;
    if (N.ctl === 'light') {
      const st = lightState(N, L);
      style = st === 'G' ? '#2ecc71' : st === 'Y' ? '#f1c40f' : '#e74c3c';
    } else if (N.ctl === 'allstop' || (N.ctl === 'stop' && !rank)) style = COL.mark;
    else if (!rank) { style = COL.mark; dash = [0.6, 0.6]; }
    if (!style) continue;
    ctx.strokeStyle = style; ctx.lineWidth = N.ctl === 'light' ? 0.6 : 0.45;
    ctx.setLineDash(dash || []);
    for (const ln of L.allLanes) {
      const p = lanePos(ln, ln.s1 - 0.3, 0, {});
      const rx = -p.hy, ry = p.hx;
      ctx.beginPath();
      ctx.moveTo(p.x - rx * LANE_W * 0.48, p.y - ry * LANE_W * 0.48);
      ctx.lineTo(p.x + rx * LANE_W * 0.48, p.y + ry * LANE_W * 0.48);
      ctx.stroke();
    }
    ctx.setLineDash([]);
  }
}

function drawSigns(ctx, N) {
  const s = View.scale;
  if (s < 0.75 || (N.edges.length < 3 && !N.ring)) return;
  for (const L of N.inLinks) {
    const rank = N.rank.get(L);
    const ln = L.lanes[0];
    const p = lanePos(ln, ln.s1 - 1.5, LANE_W * 0.5 + 1.4, {});
    if (N.ctl === 'light') { drawLight(ctx, p.x, p.y, lightState(N, L), p.hx, p.hy); continue; }
    if (N.ctl === 'allstop' || (N.ctl === 'stop' && !rank)) drawStop(ctx, p.x, p.y);
    else if (!rank) drawYield(ctx, p.x, p.y);
    else if (!N.ring) drawPriority(ctx, p.x, p.y);
  }
}

function drawYield(ctx, x, y) {
  ctx.beginPath();
  ctx.moveTo(x - 1.1, y - 0.8); ctx.lineTo(x + 1.1, y - 0.8); ctx.lineTo(x, y + 1.1); ctx.closePath();
  ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = '#d0021b'; ctx.lineWidth = 0.35; ctx.stroke();
}
function drawStop(ctx, x, y) {
  ctx.beginPath();
  for (let i = 0; i < 8; i++) { const a = Math.PI / 8 + i * Math.PI / 4; (i ? ctx.lineTo : ctx.moveTo).call(ctx, x + Math.cos(a) * 1.1, y + Math.sin(a) * 1.1); }
  ctx.closePath(); ctx.fillStyle = '#d0021b'; ctx.fill(); ctx.strokeStyle = '#fff'; ctx.lineWidth = 0.18; ctx.stroke();
}
function drawPriority(ctx, x, y) {
  ctx.beginPath();
  ctx.moveTo(x, y - 1); ctx.lineTo(x + 1, y); ctx.lineTo(x, y + 1); ctx.lineTo(x - 1, y); ctx.closePath();
  ctx.fillStyle = '#fff'; ctx.fill();
  ctx.beginPath();
  ctx.moveTo(x, y - 0.7); ctx.lineTo(x + 0.7, y); ctx.lineTo(x, y + 0.7); ctx.lineTo(x - 0.7, y); ctx.closePath();
  ctx.fillStyle = '#f5c400'; ctx.fill();
}
function drawLight(ctx, x, y, st, hx, hy) {
  ctx.save(); ctx.translate(x, y); ctx.transform(hx, hy, -hy, hx, 0, 0);
  ctx.fillStyle = '#222'; ctx.fillRect(-0.55, -1.5, 1.1, 3);
  const cols = [st === 'R' ? '#ff3b30' : '#4a1512', st === 'Y' ? '#ffcc00' : '#4a3a0a', st === 'G' ? '#34c759' : '#0f3a1a'];
  for (let i = 0; i < 3; i++) { ctx.fillStyle = cols[i]; ctx.beginPath(); ctx.arc(0, -0.95 + i * 0.95, 0.38, 0, TAU); ctx.fill(); }
  ctx.restore();
}

function drawSpeedSigns(ctx, e) {
  if (View.scale < 1.6 || e.ring) return;
  for (const L of [e.linkF, e.linkB]) {
    if (!L || L.len < 30) continue;
    const ln = L.lanes[0];
    const p = lanePos(ln, ln.s0 + 6, LANE_W * 0.5 + 1.4, {});
    ctx.beginPath(); ctx.arc(p.x, p.y, 1.05, 0, TAU);
    ctx.fillStyle = '#fff'; ctx.fill(); ctx.strokeStyle = '#d0021b'; ctx.lineWidth = 0.25; ctx.stroke();
    ctx.fillStyle = '#111'; ctx.font = 'bold 1px sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillText(String(e.kmh), p.x, p.y + 0.05);
  }
}

// ---------- Fahrzeuge ----------
const _vp = {};
function drawVehicles(ctx, list, alpha) {
  const k = View.dpr * View.scale;
  const ox = View.dpr * (View.W / 2 - View.cx * View.scale), oy = View.dpr * (View.H / 2 - View.cy * View.scale);
  const s = View.scale;
  const blink = (Math.floor(performance.now() / 300) % 2) === 0;
  ctx.globalAlpha = alpha;
  for (const v of list) {
    const p = vehPose(v, _vp);
    let hx = p.hx, hy = p.hy;
    if (v.lcOff && v.lane) {
      const yaw = -clamp(v.lcOff * 0.09, -0.25, 0.25);
      const c = Math.cos(yaw), sn = Math.sin(yaw);
      const nx = hx * c - hy * sn, ny = hx * sn + hy * c; hx = nx; hy = ny;
    }
    ctx.setTransform(k * hx, k * hy, -k * hy, k * hx, ox + k * p.x, oy + k * p.y);
    const L = v.len, Wd = v.w;
    if (s < 0.3) { ctx.fillStyle = v.crashed ? '#ff3b30' : v.color; ctx.fillRect(-L / 2, -Wd / 2 - 0.4, L, Wd + 0.8); continue; }
    if (v.crashed) {
      ctx.fillStyle = blink ? 'rgba(255,80,0,0.55)' : 'rgba(255,200,0,0.35)';
      ctx.beginPath(); ctx.arc(0, 0, L * 0.6 + 1.5, 0, TAU); ctx.fill();
    }
    if (v.truck) {
      ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(-L / 2 + 0.3, -Wd / 2 + 0.4, L, Wd);
      ctx.fillStyle = v.color; ctx.fillRect(-L / 2, -Wd / 2, L - 2.6, Wd);
      ctx.fillStyle = '#3d4b5c'; ctx.fillRect(L / 2 - 2.4, -Wd / 2 + 0.05, 2.4, Wd - 0.1);
      if (s > 1.5) { ctx.fillStyle = '#9fc6e6'; ctx.fillRect(L / 2 - 0.7, -Wd / 2 + 0.25, 0.45, Wd - 0.5); }
    } else {
      ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(-L / 2 + 0.25, -Wd / 2 + 0.35, L, Wd);
      ctx.fillStyle = v.color; ctx.fillRect(-L / 2, -Wd / 2, L, Wd);
      if (s > 1.5) {
        ctx.fillStyle = 'rgba(20,30,45,0.75)';
        ctx.fillRect(L * 0.08, -Wd / 2 + 0.2, L * 0.2, Wd - 0.4);
        ctx.fillRect(-L * 0.38, -Wd / 2 + 0.25, L * 0.13, Wd - 0.5);
      }
    }
    if (s > 1 && v.acc < -1.2) { ctx.fillStyle = '#ff2a2a'; ctx.fillRect(-L / 2 - 0.1, -Wd / 2 + 0.1, 0.25, 0.5); ctx.fillRect(-L / 2 - 0.1, Wd / 2 - 0.6, 0.25, 0.5); }
  }
  ctx.globalAlpha = 1;
  setWorldTf(ctx);
}

function vehLayer(v) {
  if (v.move) return 0;
  const e = v.lane.link.edge;
  if (e.level !== 0) return e.level;
  const u = v.lane.link.dir > 0 ? v.s : e.len - v.s;
  const i = clamp(Math.round(u / e.step), 0, e.n);
  return e.rock[i] ? -1 : 0;
}

// ---------- Overlays ----------
function flowColor(r) {
  r = clamp(r, 0, 1);
  if (r > 0.75) return '#2ecc71';
  if (r > 0.5) return '#f1c40f';
  if (r > 0.28) return '#e67e22';
  return '#e74c3c';
}

function drawFlowOverlay(ctx, edges) {
  ctx.globalAlpha = 0.7;
  for (const e of edges) {
    for (const L of [e.linkF, e.linkB]) {
      if (!L) continue;
      const v0 = Math.min(L.speed, e.curveV);
      ctx.strokeStyle = flowColor(L.avgV / v0);
      ctx.lineWidth = Math.max(L.n * LANE_W * 0.8, 3 / View.scale);
      const dir = L.dir;
      latLine(ctx, e, u => {
        const lat = edgeLat(e, dir, (L.n - 1) / 2, false, u);
        return dir > 0 ? lat : -lat;
      }, e.trimA, e.len - e.trimB);
    }
  }
  ctx.globalAlpha = 1;
}

function drawAccidents(ctx) {
  const s = View.scale, now = Sim.time;
  for (const a of Sim.accidents) {
    const age = now - a.t;
    if (age > 900) continue;
    const al = clamp(1 - age / 900, 0.15, 1);
    const r = Math.max(2.5, 9 / s);
    ctx.globalAlpha = al;
    ctx.fillStyle = 'rgba(231,76,60,0.35)';
    ctx.beginPath(); ctx.arc(a.x, a.y, r * 1.5, 0, TAU); ctx.fill();
    ctx.strokeStyle = '#c0392b'; ctx.lineWidth = r * 0.25;
    ctx.beginPath(); ctx.moveTo(a.x - r * 0.6, a.y - r * 0.6); ctx.lineTo(a.x + r * 0.6, a.y + r * 0.6);
    ctx.moveTo(a.x + r * 0.6, a.y - r * 0.6); ctx.lineTo(a.x - r * 0.6, a.y + r * 0.6); ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

// ---------- Hauptzeichnung ----------
function render() {
  const ctx = View.ctx, s = View.scale;
  View.frame++;
  ctx.setTransform(View.dpr, 0, 0, View.dpr, 0, 0);
  ctx.fillStyle = '#7ea65a';
  ctx.fillRect(0, 0, View.W, View.H);
  setWorldTf(ctx);
  const r = viewRect(0);
  drawTerrain(ctx, r);
  const towns = Terrain.townsInRect(r.x0 - 300, r.y0 - 300, r.x1 + 300, r.y1 + 300);
  drawTowns(ctx, r, towns);

  const ground = [], bridges = [], tunnels = [];
  for (const e of Net.edges.values()) {
    if (!bbIn(e.bb, r, e.hw + 5)) continue;
    (e.level > 0 ? bridges : e.level < 0 ? tunnels : ground).push(e);
  }
  const nodes = [];
  for (const N of Net.nodes.values()) if (N.x > r.x0 - 40 && N.x < r.x1 + 40 && N.y > r.y0 - 40 && N.y < r.y1 + 40) nodes.push(N);

  // Fahrzeuge nach Ebene
  const vG = [], vB = [], vT = [];
  for (const v of Sim.vehicles) {
    if (v.dead) continue;
    const p = vehPose(v, _vp);
    if (p.x < r.x0 - 15 || p.x > r.x1 + 15 || p.y < r.y0 - 15 || p.y > r.y1 + 15) continue;
    const l = vehLayer(v);
    (l > 0 ? vB : l < 0 ? vT : vG).push(v);
  }

  // Tunnel
  for (const e of tunnels) {
    ctx.fillStyle = 'rgba(40,36,32,0.35)';
    roadPath(ctx, e, 0, e.n, 0.5); ctx.fill();
    if (s > 0.3) {
      ctx.strokeStyle = 'rgba(30,30,30,0.6)'; ctx.lineWidth = 0.5; ctx.setLineDash([2, 2]);
      roadPath(ctx, e, 0, e.n, 0.5); ctx.stroke(); ctx.setLineDash([]);
    }
  }
  drawVehicles(ctx, vT, 0.35);
  for (const e of tunnels) drawPortals(ctx, e);

  // Bodenstrassen: Bruecken-Unterbau ueber Wasser
  for (const e of ground) {
    for (const [i0, i1] of runs(e.wat, e.n)) drawBridgeDeck(ctx, e, i0, i1);
  }
  for (const e of ground) drawEdgeSurface(ctx, e, COL.asphalt);
  if (s >= 0.12) {
    ctx.fillStyle = COL.asphalt;
    for (const N of nodes) {
      if (N.edges.length >= 2 && N.edges.some(e => e.level === 0) && nodePoly(ctx, N)) ctx.fill();
    }
  }
  // Ringinseln
  const ringIds = new Set();
  for (const N of nodes) if (N.ring) ringIds.add(N.ring);
  for (const id of ringIds) {
    const rg = Net.rings.get(id);
    if (!rg) continue;
    ctx.fillStyle = COL.island;
    ctx.beginPath(); ctx.arc(rg.cx, rg.cy, Math.max(2, rg.R - rg.w / 2 - 0.3), 0, TAU); ctx.fill();
    if (s > 0.5) { ctx.strokeStyle = '#d9d9d9'; ctx.lineWidth = 0.5; ctx.stroke(); }
    if (s > 0.9) { ctx.fillStyle = '#4f8a3a'; ctx.beginPath(); ctx.arc(rg.cx, rg.cy, Math.max(1, rg.R * 0.25), 0, TAU); ctx.fill(); }
  }
  // Fels/Tunnel-Abschnitte auf Bodenstrassen
  for (const e of ground) {
    for (const [i0, i1] of runs(e.rock, e.n)) {
      ctx.fillStyle = 'rgba(120,112,104,0.82)';
      roadPath(ctx, e, i0, i1, 0.6); ctx.fill();
      if (s > 0.3) { ctx.strokeStyle = 'rgba(40,40,40,0.7)'; ctx.lineWidth = 0.4; ctx.setLineDash([2, 2]); roadPath(ctx, e, i0, i1, 0.6); ctx.stroke(); ctx.setLineDash([]); }
    }
  }
  for (const e of ground) drawMarkings(ctx, e);
  for (const N of nodes) drawStopLines(ctx, N);
  if (View.showFlow) drawFlowOverlay(ctx, ground);
  drawVehicles(ctx, vG, 1);
  // Felsabdeckung ueber Fahrzeugen im automatischen Tunnel
  // Bruecken
  for (const e of bridges) {
    drawBridgeDeck(ctx, e, 0, e.n);
    ctx.fillStyle = COL.asphalt; roadPath(ctx, e, 0, e.n, 0); ctx.fill();
    drawMarkings(ctx, e);
  }
  if (View.showFlow) drawFlowOverlay(ctx, bridges);
  drawVehicles(ctx, vB, 1);
  for (const N of nodes) drawSigns(ctx, N);
  for (const e of ground) drawSpeedSigns(ctx, e);
  for (const e of bridges) drawSpeedSigns(ctx, e);
  if (View.showAcc) drawAccidents(ctx);
  drawHighlights(ctx);
  drawPreview(ctx);
  // Bildschirm-Ebene
  ctx.setTransform(View.dpr, 0, 0, View.dpr, 0, 0);
  drawTownLabels(ctx, towns);
  drawNodeBadges(ctx, nodes);
  drawScaleBar(ctx);
}

function drawPortals(ctx, e) {
  if (View.scale < 0.3) return;
  for (const u of [Math.min(3, e.len / 2), Math.max(e.len - 3, e.len / 2)]) {
    const p = edgeSample(e, u, {});
    const R = edgeRight(e, u) + 0.8, Lf = edgeLeft(e, u) + 0.8;
    ctx.strokeStyle = '#3a342e'; ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(p.x - p.ty * R, p.y + p.tx * R); ctx.lineTo(p.x + p.ty * Lf, p.y - p.tx * Lf);
    ctx.stroke();
  }
}

function drawHighlights(ctx) {
  const h = View.hover;
  const s = View.scale;
  if (h && h.edge && Net.edges.has(h.edge.id)) {
    const e = h.edge;
    ctx.strokeStyle = h.color || '#ffd54a'; ctx.lineWidth = Math.max(0.6, 2.5 / s);
    roadPath(ctx, e, 0, e.n, 0.6); ctx.stroke();
    if (h.end !== undefined) {
      const u = h.end ? e.len - e.trimB - TURN_LEN / 2 : e.trimA + TURN_LEN / 2;
      const p = edgeSample(e, clamp(u, 0, e.len), {});
      ctx.fillStyle = 'rgba(255,213,74,0.6)';
      ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(3, 8 / s), 0, TAU); ctx.fill();
    }
  }
  if (h && h.node && !h.node.deleted) {
    ctx.strokeStyle = h.color || '#ffd54a'; ctx.lineWidth = Math.max(0.6, 2.5 / s);
    ctx.beginPath(); ctx.arc(h.node.x, h.node.y, Math.max(h.node.trim + 4, 8 / s), 0, TAU); ctx.stroke();
  }
  const sel = View.selected;
  if (sel && sel.node && !sel.node.deleted) {
    ctx.strokeStyle = '#4fc3f7'; ctx.lineWidth = Math.max(0.6, 3 / s); ctx.setLineDash([3 / s, 3 / s]);
    ctx.beginPath(); ctx.arc(sel.node.x, sel.node.y, Math.max(sel.node.trim + 6, 10 / s), 0, TAU); ctx.stroke();
    ctx.setLineDash([]);
  }
  if (sel && sel.edge && Net.edges.has(sel.edge.id)) {
    ctx.strokeStyle = '#4fc3f7'; ctx.lineWidth = Math.max(0.6, 3 / s);
    roadPath(ctx, sel.edge, 0, sel.edge.n, 0.8); ctx.stroke();
  }
}

function drawPreview(ctx) {
  const pv = View.preview;
  if (!pv) return;
  const s = View.scale;
  const sp = pv.spec;
  const hw = (sp.nF + sp.nB) * LANE_W / 2 + (sp.nB ? (sp.median || 0) / 2 : 0);
  const N = 40;
  ctx.beginPath();
  for (let i = 0; i <= N; i++) {
    const p = qPoint(pv.p0, pv.c, pv.p1, i / N);
    i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
  }
  ctx.lineCap = 'round';
  ctx.strokeStyle = pv.ok ? (pv.level > 0 ? 'rgba(120,180,255,0.55)' : pv.level < 0 ? 'rgba(200,150,90,0.55)' : 'rgba(255,255,255,0.5)') : 'rgba(255,70,70,0.5)';
  ctx.lineWidth = Math.max(hw * 2, 3 / s);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = Math.max(0.2, 1 / s); ctx.setLineDash([4 / s, 4 / s]);
  ctx.stroke(); ctx.setLineDash([]);
  ctx.lineCap = 'butt';
  if (pv.ctrlShown) {
    ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1 / s;
    ctx.beginPath(); ctx.moveTo(pv.p0.x, pv.p0.y); ctx.lineTo(pv.c.x, pv.c.y); ctx.lineTo(pv.p1.x, pv.p1.y); ctx.stroke();
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(pv.c.x, pv.c.y, 4 / s, 0, TAU); ctx.fill();
  }
  for (const [p, snap] of [[pv.p0, pv.snap0], [pv.p1, pv.snap1]]) {
    if (!snap) continue;
    ctx.fillStyle = snap.type === 'node' ? '#4fc3f7' : snap.type === 'edge' ? '#ffd54a' : 'rgba(255,255,255,0.8)';
    ctx.beginPath(); ctx.arc(p.x, p.y, 5 / s, 0, TAU); ctx.fill();
  }
}

function drawTownLabels(ctx, towns) {
  const s = View.scale;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const placed = [];
  const sorted = towns.slice().sort((a, b) => ((b.node && b.node.edges.length ? 1e6 : 0) + b.pop) - ((a.node && a.node.edges.length ? 1e6 : 0) + a.pop));
  for (const t of sorted) {
    const p = w2s(t.x, t.y);
    if (p.x < -100 || p.x > View.W + 100 || p.y < -50 || p.y > View.H + 50) continue;
    const y = p.y - Math.max(18, Terrain.townRadius(t) * s * 0.6);
    const box = { x0: p.x - 75, x1: p.x + 75, y0: y - 18, y1: y + 18 };
    if (placed.some(b => !(box.x1 < b.x0 || box.x0 > b.x1 || box.y1 < b.y0 || box.y0 > b.y1))) continue;
    placed.push(box);
    const big = t.pop >= 5000;
    ctx.font = (big ? '600 15px' : '600 13px') + ' system-ui, sans-serif';
    const label = t.name;
    const sub = t.pop.toLocaleString('de-DE') + ' Einw.' + (t.node && t.node.edges.length ? '' : ' · nicht angebunden');
    const w = Math.max(ctx.measureText(label).width, 0) + 16;
    ctx.font = '11px system-ui, sans-serif';
    const w2 = ctx.measureText(sub).width + 16;
    const bw = Math.max(w, w2);
    const connected = t.node && t.node.edges.length;
    ctx.fillStyle = connected ? 'rgba(20,32,48,0.82)' : 'rgba(20,32,48,0.6)';
    roundRect(ctx, p.x - bw / 2, y - 17, bw, 33, 6); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = (big ? '600 15px' : '600 13px') + ' system-ui, sans-serif';
    ctx.fillText(label, p.x, y - 6);
    ctx.fillStyle = connected ? '#9fd3ff' : '#c9d3dd'; ctx.font = '11px system-ui, sans-serif';
    ctx.fillText(sub, p.x, y + 8);
    if (connected && t.queue.length > 3) {
      ctx.fillStyle = t.queue.length > 20 ? '#e74c3c' : '#e67e22';
      const txt = t.queue.length + ' warten';
      ctx.font = 'bold 10px system-ui, sans-serif';
      const tw = ctx.measureText(txt).width + 10;
      roundRect(ctx, p.x - tw / 2, y + 18, tw, 15, 7); ctx.fill();
      ctx.fillStyle = '#fff'; ctx.fillText(txt, p.x, y + 25.5);
    }
  }
}

function drawNodeBadges(ctx, nodes) {
  if (!View.showAcc || View.scale < 0.15) return;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = 'bold 10px system-ui, sans-serif';
  for (const N of nodes) {
    if (!N.accidents) continue;
    const p = w2s(N.x, N.y);
    const r = 9;
    ctx.fillStyle = 'rgba(192,57,43,0.9)';
    ctx.beginPath(); ctx.arc(p.x + 14, p.y - 14, r, 0, TAU); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.fillText(String(N.accidents), p.x + 14, p.y - 13.5);
  }
}

function drawScaleBar(ctx) {
  const s = View.scale;
  const target = 120 / s;
  const pow = Math.pow(10, Math.floor(Math.log10(target)));
  let m = pow;
  for (const f of [1, 2, 5, 10]) if (f * pow <= target) m = f * pow;
  const px = m * s;
  const x = 16, y = View.H - 22;
  ctx.strokeStyle = 'rgba(0,0,0,0.6)'; ctx.lineWidth = 4;
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + px, y); ctx.stroke();
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + px, y); ctx.stroke();
  ctx.fillStyle = '#fff'; ctx.font = '600 11px system-ui, sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
  ctx.shadowColor = 'rgba(0,0,0,0.7)'; ctx.shadowBlur = 3;
  ctx.fillText(m >= 1000 ? (m / 1000) + ' km' : m + ' m', x, y - 5);
  ctx.shadowBlur = 0;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath();
}
