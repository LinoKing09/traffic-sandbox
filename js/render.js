'use strict';
// ---------- Darstellung ----------
const View = {
  cx: 0, cy: 0, scale: 1.2, W: 800, H: 600, dpr: 1, canvas: null, ctx: null,
  showFlow: false, showAcc: true, hover: null, preview: null, selected: null, frame: 0,
};

const COL = {
  asphalt: '#4b4e54', bridge: '#767a82', bridgeEdge: '#d6d8dc', mark: '#f2f2f2',
  island: '#78a957', shadow: 'rgba(0,0,0,0.28)', drive: '#8d8a84',
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
  const lod = s >= 1.0 ? 0 : s >= 0.2 ? 1 : s >= 0.06 ? 2 : 3;
  const { size } = CHUNK_LODS[lod];
  const c0 = Math.floor(r.x0 / size), c1 = Math.floor(r.x1 / size);
  const r0 = Math.floor(r.y0 / size), r1 = Math.floor(r.y1 / size);
  const t0 = performance.now();
  ctx.imageSmoothingEnabled = true;
  const ov = 1 / s;
  const list = [];
  const mx = (c0 + c1) / 2, my = (r0 + r1) / 2;
  for (let cy = r0; cy <= r1; cy++) for (let cx = c0; cx <= c1; cx++) list.push([cx, cy, (cx - mx) ** 2 + (cy - my) ** 2]);
  list.sort((a, b) => a[2] - b[2]);
  for (const [cx, cy] of list) {
    const ch = Terrain.getChunk(lod, cx, cy, performance.now() - t0 < 9);
    if (ch) { ctx.drawImage(ch.cv, ch.x0, ch.y0, size + ov, size + ov); continue; }
    let drawn = false;
    for (let l2 = lod + 1; l2 < CHUNK_LODS.length && !drawn; l2++) {
      const S2 = CHUNK_LODS[l2].size, res = CHUNK_LODS[l2].res;
      const px = Math.floor(cx * size / S2), py = Math.floor(cy * size / S2);
      const p = Terrain.getChunk(l2, px, py, false);
      if (p) {
        const f = res / S2;
        ctx.drawImage(p.cv, (cx * size - px * S2) * f, (cy * size - py * S2) * f, size * f, size * f, cx * size, cy * size, size + ov, size + ov);
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
    const hs = Terrain.townHouses(t);
    // Einfahrten
    ctx.strokeStyle = COL.drive; ctx.lineWidth = 2.6; ctx.lineCap = 'round';
    ctx.beginPath();
    for (const h of hs) {
      if (!h.att || h.gone) continue;
      const e = h.att.edge;
      const p = edgeSample(e, h.att.u, {});
      const side = (h.x - p.x) * -p.ty + (h.y - p.y) * p.tx > 0 ? 1 : -1;
      const off = side > 0 ? edgeRight(e, h.att.u) : edgeLeft(e, h.att.u);
      ctx.moveTo(p.x - p.ty * off * side, p.y + p.tx * off * side);
      ctx.lineTo(h.x, h.y);
    }
    ctx.stroke(); ctx.lineCap = 'butt';
    for (const h of hs) {
      if (h.gone) continue;
      ctx.save();
      ctx.translate(h.x, h.y); ctx.rotate(h.a);
      ctx.globalAlpha = h.att ? 1 : 0.55;
      ctx.fillStyle = 'rgba(0,0,0,0.22)'; ctx.fillRect(-h.w / 2 + 1, -h.h / 2 + 1, h.w, h.h);
      ctx.fillStyle = h.roof; ctx.fillRect(-h.w / 2, -h.h / 2, h.w, h.h);
      if (s > 0.8) { ctx.fillStyle = 'rgba(0,0,0,0.15)'; ctx.fillRect(-h.w / 2, 0, h.w, h.h / 2); }
      ctx.restore();
    }
    ctx.globalAlpha = 1;
  }
}

// ---------- Strassen ----------
function roadPath(ctx, e, i0, i1, ext) {
  ext = ext || 0;
  ctx.beginPath();
  for (let i = i0; i <= i1; i++) {
    const R = edgeRight(e, i * e.step) + ext;
    const x = e.px[i] - e.ty[i] * R, y = e.py[i] + e.tx[i] * R;
    if (i === i0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
  }
  for (let i = i1; i >= i0; i--) {
    const Lf = edgeLeft(e, i * e.step) + ext;
    ctx.lineTo(e.px[i] + e.ty[i] * Lf, e.py[i] - e.tx[i] * Lf);
  }
  ctx.closePath();
}

function latLine(ctx, e, latFn, u0, u1) {
  if (u1 - u0 < 0.5) return;
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
    const u = e.A === N ? e.trimA : e.len - e.trimB;
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

// Linie in Vorwaertskoordinaten zwischen zwei Spuren eines Links
function laneDivider(ctx, L, a, b) {
  const e = L.edge, dir = L.dir;
  let sA = Math.max(a.s0, b.s0), sB = Math.min(a.s1, b.s1);
  if (a.kind !== 'N' || b.kind !== 'N') sA -= TAPER * 0.4;
  const fn = u => { const s = dir > 0 ? u : e.len - u; const l = (edgeLat(e, dir, a, u) + edgeLat(e, dir, b, u)) / 2; return dir > 0 ? l : -l; };
  if (dir > 0) latLine(ctx, e, fn, sA, sB); else latLine(ctx, e, fn, e.len - sB, e.len - sA);
}

function drawMarkings(ctx, e) {
  const s = View.scale;
  if (s < 0.55) return;
  const m = e.median / 2;
  const u0 = e.trimA, u1 = e.len - e.trimB;
  if (u1 - u0 < 1) return;
  ctx.strokeStyle = COL.mark;
  ctx.lineWidth = 0.15;
  if (s > 1 && !e.ring) {
    ctx.setLineDash([]);
    latLine(ctx, e, u => edgeRight(e, u) - 0.35, u0, u1);
    latLine(ctx, e, u => -(edgeLeft(e, u) - 0.35), u0, u1);
  }
  for (const L of [e.linkF, e.linkB]) {
    if (!L) continue;
    const al = L.allLanes;
    for (let k = 0; k + 1 < al.length; k++) {
      const turn = al[k].kind !== 'N' || al[k + 1].kind !== 'N';
      ctx.setLineDash(turn ? [1.5, 1.5] : [3, 6]);
      ctx.lineWidth = turn ? 0.25 : 0.15;
      laneDivider(ctx, L, al[k], al[k + 1]);
    }
  }
  ctx.lineWidth = 0.15;
  if (e.nB > 0) {
    const ctr = u => edgeCenter(e, u);
    if (m > 0) {
      ctx.setLineDash([]);
      ctx.strokeStyle = '#6f8f55'; ctx.lineWidth = e.median - 0.4;
      latLine(ctx, e, ctr, u0, u1);
      ctx.strokeStyle = COL.mark; ctx.lineWidth = 0.15;
      latLine(ctx, e, u => ctr(u) - m + 0.1, u0, u1);
      latLine(ctx, e, u => ctr(u) + m - 0.1, u0, u1);
    } else {
      const solid = e.nF + e.nB > 2 || e.okF || e.okB;
      ctx.setLineDash(solid ? [] : [4, 5]);
      ctx.lineWidth = e.nF + e.nB > 2 ? 0.3 : 0.15;
      latLine(ctx, e, ctr, u0, u1);
    }
  }
  ctx.setLineDash([]);
}

// Richtungspfeile (Zeichen 297)
function drawLaneArrow(ctx, x, y, hx, hy, mask) {
  ctx.save();
  ctx.translate(x, y); ctx.transform(hx, hy, -hy, hx, 0, 0);
  ctx.strokeStyle = COL.mark; ctx.fillStyle = COL.mark; ctx.lineWidth = 0.32; ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.moveTo(-2.6, 0); ctx.lineTo(0, 0); ctx.stroke();
  if (mask & ARR_S) {
    ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(1.6, 0); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(2.6, 0); ctx.lineTo(1.5, -0.5); ctx.lineTo(1.5, 0.5); ctx.fill();
  }
  for (const [bit, sg] of [[ARR_R, 1], [ARR_L, -1]]) {
    if (!(mask & bit)) continue;
    ctx.beginPath(); ctx.moveTo(-0.6, 0); ctx.quadraticCurveTo(0.6, 0, 0.6, 0.9 * sg); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(0.6, 1.8 * sg); ctx.lineTo(0.1, 0.8 * sg); ctx.lineTo(1.1, 0.8 * sg); ctx.fill();
  }
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

function isJunction(N) { return N.edges.length >= 3 || N.ring; }

function drawStopLines(ctx, N) {
  const s = View.scale;
  if (s < 0.45 || !isJunction(N)) return;
  for (const L of N.inLinks) {
    const rank = N.rank.get(L);
    let style = null, dash = null;
    if (N.ctl === 'light') {
      const st = lightState(N, L);
      style = st === 'G' ? '#2ecc71' : st === 'Y' ? '#f1c40f' : '#e74c3c';
    } else if (N.ctl === 'stop' && !rank) style = COL.mark;
    else if (!rank) { style = COL.mark; dash = [0.6, 0.6]; }
    if (style) {
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
    if (s > 1 && !N.ring && L.len > 20) {
      const multi = L.allLanes.length > 1;
      for (const ln of L.allLanes) {
        if (!ln.arrowMask || (!multi && ln.arrowMask === L.outKinds)) continue;
        const p = lanePos(ln, ln.s1 - 7, 0, {});
        drawLaneArrow(ctx, p.x, p.y, p.hx, p.hy, ln.arrowMask);
      }
    }
  }
}

function drawSigns(ctx, N) {
  if (View.scale < 0.75 || !isJunction(N)) return;
  for (const L of N.inLinks) {
    const rank = N.rank.get(L);
    const ln = L.allLanes[0];
    const p = lanePos(ln, ln.s1 - 1.5, LANE_W * 0.5 + 1.4, {});
    if (N.ctl === 'light') {
      drawLight(ctx, p.x, p.y, lightState(N, L), p.hx, p.hy);
      if (N.gruen) drawGreenArrow(ctx, p.x - p.hx * 2.2, p.y - p.hy * 2.2);
      continue;
    }
    if (N.ctl === 'rvl') continue;
    if (N.ring && !rank) { drawRoundaboutSign(ctx, p.x - p.hx * 2.6, p.y - p.hy * 2.6); drawYield(ctx, p.x, p.y); continue; }
    if (N.ctl === 'stop' && !rank) drawStop(ctx, p.x, p.y);
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
function drawRoundaboutSign(ctx, x, y) {
  ctx.beginPath(); ctx.arc(x, y, 1.05, 0, TAU); ctx.fillStyle = '#1f5fbf'; ctx.fill();
  ctx.strokeStyle = '#fff'; ctx.lineWidth = 0.2; ctx.beginPath(); ctx.arc(x, y, 0.55, 0, TAU); ctx.stroke();
}
function drawGreenArrow(ctx, x, y) {
  ctx.fillStyle = '#111'; ctx.fillRect(x - 0.6, y - 0.45, 1.2, 0.9);
  ctx.strokeStyle = '#2ecc71'; ctx.lineWidth = 0.18;
  ctx.beginPath(); ctx.moveTo(x - 0.35, y); ctx.lineTo(x + 0.35, y); ctx.lineTo(x + 0.1, y - 0.2); ctx.moveTo(x + 0.35, y); ctx.lineTo(x + 0.1, y + 0.2); ctx.stroke();
}
function drawLight(ctx, x, y, st, hx, hy) {
  ctx.save(); ctx.translate(x, y); ctx.transform(hx, hy, -hy, hx, 0, 0);
  ctx.fillStyle = '#222'; ctx.fillRect(-0.55, -1.5, 1.1, 3);
  const cols = [st === 'R' ? '#ff3b30' : '#4a1512', st === 'Y' ? '#ffcc00' : '#4a3a0a', st === 'G' ? '#34c759' : '#0f3a1a'];
  for (let i = 0; i < 3; i++) { ctx.fillStyle = cols[i]; ctx.beginPath(); ctx.arc(0, -0.95 + i * 0.95, 0.38, 0, TAU); ctx.fill(); }
  ctx.restore();
}

function drawEdgeSigns(ctx, e) {
  const s = View.scale;
  if (s < 0.9 || e.ring) return;
  // Einbahnstrasse (Zeichen 220) und Verbot der Einfahrt (Zeichen 267)
  if (e.nB === 0 && e.len > 30) {
    const ln = e.linkF.lanes[0];
    const p = lanePos(ln, ln.s0 + 4, LANE_W * 0.5 + 1.4, {});
    ctx.save(); ctx.translate(p.x, p.y); ctx.transform(p.hx, p.hy, -p.hy, p.hx, 0, 0);
    ctx.fillStyle = '#1f5fbf'; ctx.fillRect(-1.3, -0.5, 2.6, 1);
    ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.moveTo(-1, -0.15); ctx.lineTo(0.5, -0.15); ctx.lineTo(0.5, -0.35); ctx.lineTo(1.05, 0); ctx.lineTo(0.5, 0.35); ctx.lineTo(0.5, 0.15); ctx.lineTo(-1, 0.15); ctx.fill();
    ctx.restore();
    const u = e.len - e.trimB - 3;
    const q = edgeSample(e, u, {});
    const l = -(edgeLeft(e, u) + 1.4);
    const x = q.x - q.ty * l, y = q.y + q.tx * l;
    ctx.beginPath(); ctx.arc(x, y, 1.05, 0, TAU); ctx.fillStyle = '#d0021b'; ctx.fill();
    ctx.fillStyle = '#fff'; ctx.save(); ctx.translate(x, y); ctx.transform(-q.tx, -q.ty, q.ty, -q.tx, 0, 0); ctx.fillRect(-0.18, -0.65, 0.36, 1.3); ctx.restore();
  }
  // Tempolimit (Zeichen 274)
  if (s < 1.6) return;
  for (const L of [e.linkF, e.linkB]) {
    if (!L || L.len < 40) continue;
    const ln = L.lanes[0];
    const p = lanePos(ln, ln.s0 + (e.nB === 0 ? 9 : 6), LANE_W * 0.5 + 1.4, {});
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
    ctx.fillStyle = 'rgba(0,0,0,0.25)'; ctx.fillRect(-L / 2 + 0.3, -Wd / 2 + 0.4, L, Wd);
    if (v.truck) {
      ctx.fillStyle = v.color; ctx.fillRect(-L / 2, -Wd / 2, L - 2.6, Wd);
      ctx.fillStyle = '#3d4b5c'; ctx.fillRect(L / 2 - 2.4, -Wd / 2 + 0.05, 2.4, Wd - 0.1);
      if (s > 1.5) { ctx.fillStyle = '#9fc6e6'; ctx.fillRect(L / 2 - 0.7, -Wd / 2 + 0.25, 0.45, Wd - 0.5); }
    } else {
      ctx.fillStyle = v.color; ctx.fillRect(-L / 2, -Wd / 2, L, Wd);
      if (s > 1.5) {
        ctx.fillStyle = 'rgba(20,30,45,0.75)';
        ctx.fillRect(L * 0.08, -Wd / 2 + 0.2, L * 0.2, Wd - 0.4);
        ctx.fillRect(-L * 0.38, -Wd / 2 + 0.25, L * 0.13, Wd - 0.5);
      }
    }
    if (s > 1 && v.acc < -1.2) { ctx.fillStyle = '#ff2a2a'; ctx.fillRect(-L / 2 - 0.1, -Wd / 2 + 0.1, 0.25, 0.5); ctx.fillRect(-L / 2 - 0.1, Wd / 2 - 0.6, 0.25, 0.5); }
    if (s > 1 && v.exitHere && v.arriveS - v.s < 25) { ctx.fillStyle = blink ? '#ffb300' : '#7a5a00'; ctx.fillRect(L / 2 - 0.5, Wd / 2 - 0.3, 0.5, 0.35); }
  }
  ctx.globalAlpha = 1;
  setWorldTf(ctx);
}

function vehLayer(v) {
  if (v.move) return 0;
  const e = v.lane.link.edge;
  if (e.level !== 0) return e.level;
  const u = v.lane.link.dir > 0 ? v.s : e.len - v.s;
  return e.rock[clamp(Math.round(u / e.step), 0, e.n)] ? -1 : 0;
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
      ctx.strokeStyle = flowColor(L.avgV / Math.min(L.speed, e.curveV));
      ctx.lineWidth = Math.max(L.n * LANE_W * 0.8, 3 / View.scale);
      const a = L.lanes[0], b = L.lanes[L.n - 1], dir = L.dir;
      latLine(ctx, e, u => { const l = (edgeLat(e, dir, a, u) + edgeLat(e, dir, b, u)) / 2; return dir > 0 ? l : -l; }, e.trimA, e.len - e.trimB);
    }
  }
  ctx.globalAlpha = 1;
}

function drawAccidents(ctx) {
  const s = View.scale, now = Sim.time;
  for (const a of Sim.accidents) {
    const age = now - a.t;
    if (age > 900) continue;
    const r = Math.max(2.5, 9 / s);
    ctx.globalAlpha = clamp(1 - age / 900, 0.15, 1);
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

  const vG = [], vB = [], vT = [];
  for (const v of Sim.vehicles) {
    if (v.dead) continue;
    const p = vehPose(v, _vp);
    if (p.x < r.x0 - 15 || p.x > r.x1 + 15 || p.y < r.y0 - 15 || p.y > r.y1 + 15) continue;
    const l = vehLayer(v);
    (l > 0 ? vB : l < 0 ? vT : vG).push(v);
  }

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

  for (const e of ground) for (const [i0, i1] of runs(e.wat, e.n)) drawBridgeDeck(ctx, e, i0, i1);
  for (const e of ground) drawEdgeSurface(ctx, e, COL.asphalt);
  if (s >= 0.12) {
    ctx.fillStyle = COL.asphalt;
    for (const N of nodes) if (N.edges.length >= 2 && N.edges.some(e => e.level === 0) && nodePoly(ctx, N)) ctx.fill();
  }
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
  for (const e of bridges) {
    drawBridgeDeck(ctx, e, 0, e.n);
    ctx.fillStyle = COL.asphalt; roadPath(ctx, e, 0, e.n, 0); ctx.fill();
    drawMarkings(ctx, e);
  }
  if (View.showFlow) drawFlowOverlay(ctx, bridges);
  drawVehicles(ctx, vB, 1);
  for (const N of nodes) drawSigns(ctx, N);
  for (const e of ground) drawEdgeSigns(ctx, e);
  for (const e of bridges) drawEdgeSigns(ctx, e);
  if (View.showAcc) drawAccidents(ctx);
  drawHighlights(ctx);
  drawPreview(ctx);
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
    ctx.beginPath(); ctx.moveTo(p.x - p.ty * R, p.y + p.tx * R); ctx.lineTo(p.x + p.ty * Lf, p.y - p.tx * Lf); ctx.stroke();
  }
}

function drawHighlights(ctx) {
  const h = View.hover, s = View.scale;
  const lw = Math.max(0.6, 2.5 / s);
  for (const it of [h, View.selected]) {
    if (!it) continue;
    const col = it === h ? (h.color || '#ffd54a') : '#4fc3f7';
    if (it.edge && Net.edges.has(it.edge.id)) {
      const e = it.edge;
      ctx.strokeStyle = col; ctx.lineWidth = lw;
      if (it.link) {
        // nur die Zufahrt markieren
        const L = it.link, u0 = L.dir > 0 ? Math.max(e.trimA, e.len - e.trimB - 60) : e.trimA, u1 = L.dir > 0 ? e.len - e.trimB : Math.min(e.len - e.trimB, e.trimA + 60);
        const i0 = Math.floor(u0 / e.step), i1 = Math.ceil(u1 / e.step);
        roadPath(ctx, e, clamp(i0, 0, e.n), clamp(i1, 0, e.n), 0.6); ctx.stroke();
        const p = lanePos(L.lanes[0], L.lanes[0].s1 - 2, 0, {});
        ctx.fillStyle = col; ctx.beginPath(); ctx.arc(p.x, p.y, Math.max(1.5, 6 / s), 0, TAU); ctx.fill();
      } else { roadPath(ctx, e, 0, e.n, 0.6); ctx.stroke(); }
    }
    if (it.node && !it.node.deleted) {
      ctx.strokeStyle = col; ctx.lineWidth = lw;
      ctx.beginPath(); ctx.arc(it.node.x, it.node.y, Math.max(it.node.trim + 4, 9 / s), 0, TAU); ctx.stroke();
    }
  }
}

function drawPreview(ctx) {
  const pv = View.preview;
  if (!pv) return;
  const s = View.scale, sp = pv.spec;
  const hw = (sp.nF + sp.nB) * LANE_W / 2 + (sp.nB ? (sp.median || 0) / 2 : 0);
  ctx.beginPath();
  for (let i = 0; i <= 40; i++) { const p = qPoint(pv.p0, pv.c, pv.p1, i / 40); i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y); }
  ctx.lineCap = 'round';
  ctx.strokeStyle = pv.ok ? (pv.level > 0 ? 'rgba(120,180,255,0.55)' : pv.level < 0 ? 'rgba(200,150,90,0.55)' : 'rgba(255,255,255,0.5)') : 'rgba(255,70,70,0.5)';
  ctx.lineWidth = Math.max(hw * 2, 3 / s);
  ctx.stroke();
  ctx.strokeStyle = 'rgba(255,255,255,0.9)'; ctx.lineWidth = Math.max(0.2, 1 / s); ctx.setLineDash([4 / s, 4 / s]);
  ctx.stroke(); ctx.setLineDash([]); ctx.lineCap = 'butt';
  if (pv.handle) {
    ctx.strokeStyle = 'rgba(255,255,255,0.5)'; ctx.lineWidth = 1 / s;
    ctx.beginPath(); ctx.moveTo(pv.p0.x, pv.p0.y); ctx.lineTo(pv.c.x, pv.c.y); ctx.lineTo(pv.p1.x, pv.p1.y); ctx.stroke();
    ctx.fillStyle = '#ffd54a'; ctx.strokeStyle = '#1b2430'; ctx.lineWidth = 2 / s;
    ctx.beginPath(); ctx.arc(pv.c.x, pv.c.y, 11 / s, 0, TAU); ctx.fill(); ctx.stroke();
  }
  for (const [p, snap] of [[pv.p0, pv.snap0], [pv.p1, pv.snap1]]) {
    if (!snap) continue;
    ctx.fillStyle = snap.type === 'node' ? '#4fc3f7' : snap.type === 'edge' ? '#ffd54a' : 'rgba(255,255,255,0.8)';
    ctx.beginPath(); ctx.arc(p.x, p.y, 6 / s, 0, TAU); ctx.fill();
  }
  if (pv.len) {
    const m = qPoint(pv.p0, pv.c, pv.p1, 0.5);
    const sc = w2s(m.x, m.y);
    ctx.save(); ctx.setTransform(View.dpr, 0, 0, View.dpr, 0, 0);
    ctx.font = '600 12px system-ui, sans-serif'; ctx.textAlign = 'center';
    const txt = Math.round(pv.len) + ' m';
    ctx.fillStyle = 'rgba(20,32,48,0.85)'; roundRect(ctx, sc.x - 26, sc.y - 30, 52, 20, 6); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.textBaseline = 'middle'; ctx.fillText(txt, sc.x, sc.y - 20);
    ctx.restore(); setWorldTf(ctx);
  }
}

function drawTownLabels(ctx, towns) {
  const s = View.scale;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  const placed = [];
  const sorted = towns.slice().sort((a, b) => (b.nAtt * 1000 + b.pop) - (a.nAtt * 1000 + a.pop));
  for (const t of sorted) {
    const p = w2s(t.x, t.y);
    if (p.x < -100 || p.x > View.W + 100 || p.y < -50 || p.y > View.H + 50) continue;
    const y = p.y - Math.max(18, Terrain.townRadius(t) * s * 0.9);
    const box = { x0: p.x - 70, x1: p.x + 70, y0: y - 16, y1: y + 16 };
    if (placed.some(b => !(box.x1 < b.x0 || box.x0 > b.x1 || box.y1 < b.y0 || box.y0 > b.y1))) continue;
    placed.push(box);
    const total = t.houses ? t.houses.filter(h => !h.gone).length : 0;
    const sub = t.nAtt ? `🏠 ${t.nAtt}/${total} angebunden` : t.pop.toLocaleString('de-DE') + ' Einw.';
    ctx.font = '600 13px system-ui, sans-serif';
    const w1 = ctx.measureText(t.name).width;
    ctx.font = '11px system-ui, sans-serif';
    const bw = Math.max(w1, ctx.measureText(sub).width) + 16;
    ctx.fillStyle = t.nAtt ? 'rgba(20,32,48,0.85)' : 'rgba(20,32,48,0.6)';
    roundRect(ctx, p.x - bw / 2, y - 16, bw, 31, 6); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.font = '600 13px system-ui, sans-serif';
    ctx.fillText(t.name, p.x, y - 6);
    ctx.fillStyle = t.nAtt ? '#9fd3ff' : '#c9d3dd'; ctx.font = '11px system-ui, sans-serif';
    ctx.fillText(sub, p.x, y + 7);
  }
}

function drawNodeBadges(ctx, nodes) {
  if (!View.showAcc || View.scale < 0.15) return;
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.font = 'bold 10px system-ui, sans-serif';
  for (const N of nodes) {
    if (!N.accidents) continue;
    const p = w2s(N.x, N.y);
    ctx.fillStyle = 'rgba(192,57,43,0.9)';
    ctx.beginPath(); ctx.arc(p.x + 14, p.y - 14, 9, 0, TAU); ctx.fill();
    ctx.fillStyle = '#fff'; ctx.fillText(String(N.accidents), p.x + 14, p.y - 13.5);
  }
}

function drawScaleBar(ctx) {
  const s = View.scale;
  const target = 100 / s;
  const pow = Math.pow(10, Math.floor(Math.log10(target)));
  let m = pow;
  for (const f of [1, 2, 5, 10]) if (f * pow <= target) m = f * pow;
  const px = m * s;
  const x = 14, y = View.H - UIInsets.bottom - 12;
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
