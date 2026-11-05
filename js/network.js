'use strict';
// ---------- Strassennetz: Knoten, Kanten, Spuren, Abbiegebeziehungen ----------
const LANE_W = 3.5, TURN_LEN = 36, TAPER = 12;

const ROAD_PRESETS = {
  stadt: { name: 'Stadtstraße', nF: 1, nB: 1, speed: 50, median: 0 },
  land: { name: 'Landstraße', nF: 1, nB: 1, speed: 80, median: 0 },
  haupt: { name: 'Hauptstraße', nF: 2, nB: 2, speed: 60, median: 0 },
  schnell: { name: 'Schnellstraße', nF: 2, nB: 2, speed: 100, median: 2.5 },
  autobahn: { name: 'Autobahn', nF: 3, nB: 3, speed: 130, median: 4 },
  einbahn: { name: 'Einbahnstraße', nF: 2, nB: 0, speed: 50, median: 0 },
  rampe: { name: 'Auffahrt (einspurig)', nF: 1, nB: 0, speed: 70, median: 0 },
};

const Net = {
  nodes: new Map(), edges: new Map(), links: [], lanes: [], nextId: 1, rev: 0,
  dirty: new Set(), transfers: [], rings: new Map(), moveId: 1,
};

function netReset() {
  Net.nodes.clear(); Net.edges.clear(); Net.links = []; Net.lanes = []; Net.nextId = 1; Net.rev++;
  Net.dirty.clear(); Net.transfers = []; Net.rings.clear();
}

function addNode(x, y, props) {
  const n = {
    id: Net.nextId++, x, y, edges: [], ctl: 'auto', town: null, ring: 0,
    occ: new Set(), inLinks: [], outLinks: [], moves: [], trans: new Map(), transOut: new Map(),
    rank: new Map(), pen: new Map(), phases: [], light: null, majorPick: 0, major: null,
    accidents: 0, waitAvg: 0, thr: 0, thrCnt: 0, trim: 0,
  };
  if (props) Object.assign(n, props);
  Net.nodes.set(n.id, n);
  Net.dirty.add(n);
  return n;
}

function edgeSpec(e) {
  return { nF: e.nF, nB: e.nB, speed: e.kmh, median: e.median, level: e.level, ring: e.ring };
}

function addEdge(A, B, c, spec) {
  const e = {
    id: Net.nextId++, A, B, c: { x: c.x, y: c.y }, nF: spec.nF, nB: spec.nB, kmh: spec.speed,
    median: spec.nB > 0 ? (spec.median || 0) : 0, level: spec.level || 0, ring: spec.ring || 0,
    turnF: false, turnB: false, turnOkF: false, turnOkB: false, accidents: 0,
    linkF: null, linkB: null, trimA: 0, trimB: 0, geomDirty: true,
  };
  Net.edges.set(e.id, e);
  A.edges.push(e); B.edges.push(e);
  Net.dirty.add(A); Net.dirty.add(B);
  return e;
}

function killLink(L) {
  if (!L) return;
  for (const ln of L.allLanes || L.lanes) ln.alive = false;
  L.dead = true;
}

function removeEdge(e) {
  if (!Net.edges.has(e.id)) return;
  Net.edges.delete(e.id);
  for (const N of [e.A, e.B]) {
    const i = N.edges.indexOf(e);
    if (i >= 0) N.edges.splice(i, 1);
    Net.dirty.add(N);
  }
  killLink(e.linkF); killLink(e.linkB);
  for (const N of [e.A, e.B]) if (N.edges.length === 0 && !N.town) removeNodeOnly(N);
}

function removeNodeOnly(N) {
  Net.nodes.delete(N.id);
  N.deleted = true;
  Net.dirty.delete(N);
}

function removeNode(N) {
  for (const e of [...N.edges]) removeEdge(e);
  if (!N.town) removeNodeOnly(N);
}

// ---------- Geometrie ----------
function edgeProps(e) {
  e.speed = e.kmh / 3.6;
  const W = LANE_W, m = e.median / 2;
  e.c0 = e.nB === 0 ? -e.nF * W / 2 : 0;
  e.hw = Math.max(e.c0 + m + e.nF * W, -e.c0 + m + e.nB * W);
}

function edgeGeom(e) {
  const A = e.A, B = e.B, c = e.c;
  const N = Math.max(16, Math.ceil((Math.hypot(c.x - A.x, c.y - A.y) + Math.hypot(B.x - c.x, B.y - c.y)) / 2));
  const du = new Float64Array(N + 1);
  let px = A.x, py = A.y;
  for (let i = 1; i <= N; i++) {
    const p = qPoint(A, c, B, i / N);
    du[i] = du[i - 1] + Math.hypot(p.x - px, p.y - py);
    px = p.x; py = p.y;
  }
  const len = Math.max(du[N], 0.5);
  e.len = len; e.denseU = du; e.denseN = N;
  const n = Math.max(2, Math.ceil(len / 2));
  e.n = n; e.step = len / n;
  e.px = new Float32Array(n + 1); e.py = new Float32Array(n + 1);
  e.tx = new Float32Array(n + 1); e.ty = new Float32Array(n + 1);
  e.wat = new Uint8Array(n + 1); e.rock = new Uint8Array(n + 1);
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (let i = 0; i <= n; i++) {
    const t = edgeTAtU(e, i * e.step);
    const p = qPoint(A, c, B, t), tg = qTan(A, c, B, t);
    e.px[i] = p.x; e.py[i] = p.y; e.tx[i] = tg.x; e.ty[i] = tg.y;
    const inf = Terrain.info(p.x, p.y);
    e.wat[i] = inf.water ? 1 : 0; e.rock[i] = inf.rock ? 1 : 0;
    x0 = Math.min(x0, p.x); y0 = Math.min(y0, p.y); x1 = Math.max(x1, p.x); y1 = Math.max(y1, p.y);
  }
  e.bb = { x0, y0, x1, y1 };
  let maxK = 0;
  for (let i = 1; i < n; i++) {
    const d = Math.abs(angNorm(Math.atan2(e.ty[i + 1], e.tx[i + 1]) - Math.atan2(e.ty[i - 1], e.tx[i - 1])));
    maxK = Math.max(maxK, d / (2 * e.step));
  }
  e.curveV = maxK > 1e-4 ? Math.max(4, Math.sqrt(3.2 / maxK)) : 99;
  // Anteil Bruecke/Tunnel (nur fuer Statistik/Anzeige)
  e.geomDirty = false;
}

function edgeTAtU(e, u) {
  const du = e.denseU, N = e.denseN;
  if (u <= 0) return 0;
  if (u >= du[N]) return 1;
  let lo = 0, hi = N;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (du[mid] < u) lo = mid; else hi = mid; }
  const f = (u - du[lo]) / ((du[hi] - du[lo]) || 1);
  return (lo + f) / N;
}

function edgeUAtT(e, t) {
  const f = clamp(t, 0, 1) * e.denseN;
  const i = Math.min(e.denseN - 1, Math.floor(f));
  return lerp(e.denseU[i], e.denseU[i + 1], f - i);
}

const _smp = { x: 0, y: 0, tx: 1, ty: 0 };
function edgeSample(e, u, out) {
  out = out || _smp;
  const f = clamp(u, 0, e.len) / e.step;
  let i = Math.floor(f); if (i >= e.n) i = e.n - 1;
  const r = f - i;
  out.x = e.px[i] + (e.px[i + 1] - e.px[i]) * r;
  out.y = e.py[i] + (e.py[i + 1] - e.py[i]) * r;
  let tx = e.tx[i] + (e.tx[i + 1] - e.tx[i]) * r, ty = e.ty[i] + (e.ty[i + 1] - e.ty[i]) * r;
  const l = Math.hypot(tx, ty) || 1;
  out.tx = tx / l; out.ty = ty / l;
  return out;
}

function zoneF(e, u) {
  if (!e.turnOkF) return 0;
  const zs = e.len - e.trimB - TURN_LEN;
  return smooth01((u - (zs - TAPER)) / TAPER);
}
function zoneB(e, u) {
  if (!e.turnOkB) return 0;
  const ze = e.trimA + TURN_LEN;
  return smooth01((ze + TAPER - u) / TAPER);
}

// Seitlicher Versatz (positiv = rechts in Fahrtrichtung des Links)
function edgeLat(e, dir, idx, turn, u) {
  const W = LANE_W, c = e.c0, m = e.median / 2;
  const fz = zoneF(e, u), bz = zoneB(e, u);
  if (dir > 0) {
    if (turn) return c + m + 0.5 * W - W * fz;
    return c + m + (e.nF - idx - 0.5) * W + bz * W;
  }
  if (turn) return -c + m + 0.5 * W - W * bz;
  return -c + m + (e.nB - idx - 0.5) * W + fz * W;
}
function edgeRight(e, u) { return e.c0 + e.median / 2 + e.nF * LANE_W + zoneB(e, u) * LANE_W; }
function edgeLeft(e, u) { return -e.c0 + e.median / 2 + e.nB * LANE_W + zoneF(e, u) * LANE_W; }

function laneLat(lane, s) {
  const L = lane.link, e = L.edge;
  return edgeLat(e, L.dir, lane.idx, lane.turn, L.dir > 0 ? s : e.len - s);
}

const _lp = { x: 0, y: 0, hx: 1, hy: 0 };
function lanePos(lane, s, off, out) {
  out = out || _lp;
  const L = lane.link, e = L.edge;
  const u = L.dir > 0 ? s : e.len - s;
  const p = edgeSample(e, u);
  const hx = L.dir > 0 ? p.tx : -p.tx, hy = L.dir > 0 ? p.ty : -p.ty;
  const lat = edgeLat(e, L.dir, lane.idx, lane.turn, u) + (off || 0);
  out.x = p.x - hy * lat; out.y = p.y + hx * lat; out.hx = hx; out.hy = hy;
  return out;
}

// Richtung der Kante vom Knoten weg
function edgeDirAt(e, N) {
  if (e.A === N) return { x: e.tx[0], y: e.ty[0] };
  return { x: -e.tx[e.n], y: -e.ty[e.n] };
}
function totalLanes(e) { return e.nF + e.nB; }

function computeTrims(N) {
  const deg = N.edges.length;
  const data = N.edges.map(e => ({ e, d: edgeDirAt(e, N) }));
  let maxT = 0;
  for (const a of data) {
    let t = 0;
    if (deg >= 2) {
      for (const b of data) {
        if (a === b) continue;
        const dot = clamp(a.d.x * b.d.x + a.d.y * b.d.y, -1, 1);
        const phi = Math.acos(dot);
        let v;
        if (phi < 0.3) v = 30;
        else if (phi > 2.85) v = 0;
        else v = (b.e.hw + a.e.hw * Math.cos(phi)) / Math.sin(phi);
        t = Math.max(t, clamp(v, 0, 30));
      }
      if (deg >= 3 || N.ring) t += N.ring ? 1 : 2;
      if (deg === 2) {
        const o = data[0] === a ? data[1].e : data[0].e;
        t = Math.max(t + 0.5, 1.5 + Math.abs(totalLanes(a.e) - totalLanes(o)) * 6);
      }
    }
    if (a.e.A === N) a.e.trimA = t;
    if (a.e.B === N) a.e.trimB = t;
    maxT = Math.max(maxT, t);
  }
  N.trim = maxT;
}

function fixTrims(e) {
  const sum = e.trimA + e.trimB, max = e.len - 3;
  if (sum > max) {
    const k = Math.max(0, max) / (sum || 1);
    e.trimA *= k; e.trimB *= k;
  }
}

function newLane(L, idx, turn) {
  const ln = { link: L, idx, turn, s0: 0, s1: 0, vehicles: [], moves: [], alive: true, lastOut: null };
  return ln;
}

function buildLinks(e) {
  for (const dir of [1, -1]) {
    const n = dir > 0 ? e.nF : e.nB;
    const key = dir > 0 ? 'linkF' : 'linkB';
    if (n === 0) { if (e[key]) killLink(e[key]); e[key] = null; continue; }
    let L = e[key];
    if (!L || L.dead) L = e[key] = { edge: e, dir, lanes: [], turnLane: null, avgV: e.speed, flow: 0, flowCnt: 0, id: -1, vsum: 0, vcnt: 0 };
    L.from = dir > 0 ? e.A : e.B; L.to = dir > 0 ? e.B : e.A;
    L.speed = e.speed; L.n = n;
    const s0 = dir > 0 ? e.trimA : e.trimB, s1 = e.len - (dir > 0 ? e.trimB : e.trimA);
    if (L.lanes.length !== n) {
      const old = L.lanes;
      L.lanes = [];
      for (let i = 0; i < n; i++) L.lanes.push(i < old.length ? old[i] : newLane(L, i, false));
      for (let i = n; i < old.length; i++) {
        old[i].alive = false;
        const tgt = L.lanes[n - 1];
        for (const v of old[i].vehicles) { v.lane = tgt; tgt.vehicles.push(v); v.lcOff = 0; }
        old[i].vehicles = [];
      }
    }
    for (const ln of L.lanes) { ln.s0 = s0; ln.s1 = s1; }
    const want = (dir > 0 ? e.turnF : e.turnB) && (s1 - s0) > TURN_LEN + TAPER + 8 && n >= 1;
    if (dir > 0) e.turnOkF = want; else e.turnOkB = want;
    if (want && !L.turnLane) L.turnLane = newLane(L, n, true);
    else if (!want && L.turnLane) {
      const tgt = L.lanes[n - 1];
      for (const v of L.turnLane.vehicles) { v.lane = tgt; tgt.vehicles.push(v); }
      L.turnLane.vehicles = []; L.turnLane.alive = false; L.turnLane = null;
    }
    if (L.turnLane) { L.turnLane.idx = n; L.turnLane.s0 = s1 - TURN_LEN; L.turnLane.s1 = s1; }
    L.allLanes = L.turnLane ? L.lanes.concat([L.turnLane]) : L.lanes.slice();
    L.len = s1 - s0;
  }
}

function linkHeadEnd(L) {
  const e = L.edge;
  return L.dir > 0 ? { x: e.tx[e.n], y: e.ty[e.n] } : { x: -e.tx[0], y: -e.ty[0] };
}
function linkHeadStart(L) {
  const e = L.edge;
  return L.dir > 0 ? { x: e.tx[0], y: e.ty[0] } : { x: -e.tx[e.n], y: -e.ty[e.n] };
}

// ---------- Abbiegebeziehungen ----------
function makeMove(N, inLane, outLane, turn, kind) {
  const a = lanePos(inLane, inLane.s1, 0, {}), b = lanePos(outLane, outLane.s0, 0, {});
  const d = Math.hypot(b.x - a.x, b.y - a.y);
  const k = d * (Math.abs(turn) > 0.3 ? 0.45 : 0.36);
  const c1x = a.x + a.hx * k, c1y = a.y + a.hy * k, c2x = b.x - b.hx * k, c2y = b.y - b.hy * k;
  const S = 12;
  const xs = new Float32Array(S + 1), ys = new Float32Array(S + 1), ss = new Float32Array(S + 1);
  for (let i = 0; i <= S; i++) {
    const t = i / S, mt = 1 - t;
    xs[i] = mt * mt * mt * a.x + 3 * mt * mt * t * c1x + 3 * mt * t * t * c2x + t * t * t * b.x;
    ys[i] = mt * mt * mt * a.y + 3 * mt * mt * t * c1y + 3 * mt * t * t * c2y + t * t * t * b.y;
    if (i > 0) ss[i] = ss[i - 1] + Math.hypot(xs[i] - xs[i - 1], ys[i] - ys[i - 1]);
  }
  const len = Math.max(ss[S], 0.2);
  const vIn = inLane.link.speed, vOut = outLane.link.speed;
  let vmax = Math.min(vIn, vOut);
  if (Math.abs(turn) > 0.2) vmax = clamp(Math.sqrt(2.8 * len / Math.abs(turn)), 3.5, vmax);
  return { id: Net.moveId++, node: N, inLane, outLane, outLink: outLane.link, turn, kind, xs, ys, ss, len, vmax, conf: new Map(), vehicles: [] };
}

const _mp = { x: 0, y: 0, hx: 1, hy: 0 };
function movePos(m, s, out) {
  out = out || _mp;
  const ss = m.ss, S = ss.length - 1;
  s = clamp(s, 0, ss[S]);
  let i = 0;
  while (i < S - 1 && ss[i + 1] < s) i++;
  const seg = (ss[i + 1] - ss[i]) || 1;
  const f = (s - ss[i]) / seg;
  out.x = m.xs[i] + (m.xs[i + 1] - m.xs[i]) * f;
  out.y = m.ys[i] + (m.ys[i + 1] - m.ys[i]) * f;
  let hx = m.xs[i + 1] - m.xs[i], hy = m.ys[i + 1] - m.ys[i];
  const l = Math.hypot(hx, hy);
  if (l < 1e-6) { const h = linkHeadStart(m.outLink); hx = h.x; hy = h.y; } else { hx /= l; hy /= l; }
  out.hx = hx; out.hy = hy;
  return out;
}

function edgeImp(e) { return e.kmh * (e.nF + e.nB) + (e.ring ? 100000 : 0); }

function buildNode(N) {
  N.inLinks = []; N.outLinks = [];
  for (const e of N.edges) {
    for (const L of [e.linkF, e.linkB]) {
      if (!L) continue;
      if (L.to === N) N.inLinks.push(L);
      if (L.from === N) N.outLinks.push(L);
    }
  }
  const deg = N.edges.length;
  for (const L of N.inLinks) L.hEnd = linkHeadEnd(L);
  N.moves = []; N.trans = new Map(); N.transOut = new Map();
  for (const L of N.inLinks) for (const ln of L.allLanes) ln.moves = [];
  if (deg >= 3 && !N.ring && N.ctl === 'ringnode') N.ctl = 'auto';
  if (deg < 3 && !N.ring && N.ctl !== 'auto') N.ctl = 'auto';

  // Zuordnung der Spuren
  const plan = []; // {inLane, out, kind, turn}
  for (const Lin of N.inLinks) {
    const hIn = linkHeadEnd(Lin);
    const aIn = Math.atan2(hIn.y, hIn.x);
    let outs = N.outLinks.filter(o => o.edge !== Lin.edge || deg === 1);
    outs = outs.map(o => {
      const h = linkHeadStart(o);
      let turn = angNorm(Math.atan2(h.y, h.x) - aIn);
      if (o.edge === Lin.edge) turn = -Math.PI;
      const kind = Math.abs(turn) > 2.6 ? 'U' : turn > 0.5 ? 'R' : turn < -0.5 ? 'L' : 'S';
      return { o, turn, kind };
    }).sort((a, b) => b.turn - a.turn);
    if (!outs.length) continue;
    const n = Lin.n, k = outs.length;
    const assign = Lin.lanes.map(() => new Set());
    for (let j = 0; j < k; j++) {
      const c = Math.min(n - 1, Math.floor((j + 0.5) / k * n));
      assign[c].add(j);
    }
    for (let i = 0; i < n; i++) {
      const j = Math.min(k - 1, Math.floor((i + 0.5) / n * k));
      assign[i].add(j);
    }
    // Geradeaus-Spuren grosszuegiger: jede Spur, die nur Abbieger hat, aber neben Geradeaus liegt -> ok
    let turnAssign = null;
    if (Lin.turnLane && k >= 2 && outs[k - 1].turn < -0.35) {
      turnAssign = k - 1;
      for (let i = 0; i < n; i++) {
        if (assign[i].has(k - 1) && assign[i].size > 1) assign[i].delete(k - 1);
      }
      // falls normale Spuren nichts mehr haben -> leftmost bekommt naechsten
    }
    for (let i = 0; i < n; i++) for (const j of assign[i]) plan.push({ inLane: Lin.lanes[i], out: outs[j].o, kind: outs[j].kind, turn: outs[j].turn, Lin });
    if (turnAssign !== null) plan.push({ inLane: Lin.turnLane, out: outs[turnAssign].o, kind: outs[turnAssign].kind, turn: outs[turnAssign].turn, Lin });
    else if (Lin.turnLane) {
      // Abbiegespur ohne Linksabbieger: fuehrt nach links/geradeaus wie linke Spur
      for (const j of assign[n - 1]) plan.push({ inLane: Lin.turnLane, out: outs[j].o, kind: outs[j].kind, turn: outs[j].turn, Lin });
    }
  }
  // Zielspuren je Ausfahrt bestimmen
  const byOut = new Map();
  for (const p of plan) {
    if (!byOut.has(p.out)) byOut.set(p.out, new Map());
    const m = byOut.get(p.out);
    if (!m.has(p.Lin)) m.set(p.Lin, []);
    m.get(p.Lin).push(p);
  }
  for (const [o, feeders] of byOut) {
    const m = o.n;
    const hO = linkHeadStart(o), aO = Math.atan2(hO.y, hO.x);
    const fl = [...feeders.entries()].map(([Lin, ps]) => {
      const h = linkHeadEnd(Lin);
      let key = angNorm(Math.atan2(-h.y, -h.x) - aO);
      if (key < 0) key += TAU;
      ps.sort((a, b) => (a.inLane.turn ? 99 : a.inLane.idx) - (b.inLane.turn ? 99 : b.inLane.idx));
      return { Lin, ps, key };
    }).sort((a, b) => a.key - b.key);
    const total = fl.reduce((s, f) => s + f.ps.length, 0);
    if (fl.length > 1 && total <= m) {
      let off = 0;
      for (const f of fl) { f.ps.forEach((p, k) => { p.outIdx = off + k; }); off += f.ps.length; }
    } else {
      for (const f of fl) {
        const G = f.ps, g = G.length;
        G.forEach((p, k) => {
          if (g >= m) p.outIdx = g === 1 ? 0 : Math.round(k * (m - 1) / (g - 1));
          else if (p.kind === 'R') p.outIdx = k;
          else if (p.kind === 'L' || p.kind === 'U') p.outIdx = m - g + k;
          else p.outIdx = clamp(G[0].inLane.turn ? m - g : G[0].inLane.idx, 0, m - g) + k;
        });
      }
    }
  }
  for (const p of plan) {
    const mv = makeMove(N, p.inLane, p.out.lanes[clamp(p.outIdx, 0, p.out.n - 1)], p.turn, p.kind);
    p.inLane.moves.push(mv);
    N.moves.push(mv);
    if (!N.trans.has(p.out)) N.trans.set(p.out, new Set());
    N.trans.get(p.out).add(p.Lin);
    if (!N.transOut.has(p.Lin)) N.transOut.set(p.Lin, new Set());
    N.transOut.get(p.Lin).add(p.out);
  }
  for (const [k, v] of N.trans) N.trans.set(k, [...v]);
  for (const [k, v] of N.transOut) N.transOut.set(k, [...v]);

  // Konflikte
  const M = N.moves;
  if (deg >= 3 || N.ring) {
    for (let i = 0; i < M.length; i++) for (let j = i + 1; j < M.length; j++) {
      const a = M[i], b = M[j];
      if (a.inLane === b.inLane) continue;
      let c = null;
      if (a.outLane === b.outLane) c = { sa: a.len, sb: b.len, merge: true };
      else if (!N.ring) {
        const x = pathCross(a, b);
        if (x) c = { sa: x.sa, sb: x.sb, merge: false };
      }
      if (c) {
        a.conf.set(b, { sSelf: c.sa, sOther: c.sb, merge: c.merge });
        b.conf.set(a, { sSelf: c.sb, sOther: c.sa, merge: c.merge });
      }
    }
  }
  computeRanks(N);
  computePhases(N);
}

function pathCross(a, b) {
  const S = a.xs.length - 1;
  for (let i = 0; i < S; i++) for (let j = 0; j < S; j++) {
    const r = segIntersect(a.xs[i], a.ys[i], a.xs[i + 1], a.ys[i + 1], b.xs[j], b.ys[j], b.xs[j + 1], b.ys[j + 1]);
    if (r) {
      const sa = a.ss[i] + r.t * (a.ss[i + 1] - a.ss[i]);
      const sb = b.ss[j] + r.u * (b.ss[j + 1] - b.ss[j]);
      return { sa, sb };
    }
  }
  // sehr nahe Vorbeifahrt (< 2 m) zaehlt ebenfalls als Konflikt
  let best = null;
  for (let i = 1; i < S; i++) for (let j = 1; j < S; j++) {
    const d = Math.hypot(a.xs[i] - b.xs[j], a.ys[i] - b.ys[j]);
    if (d < 2.2 && (!best || d < best.d)) best = { d, sa: a.ss[i], sb: b.ss[j] };
  }
  return best;
}

function computeRanks(N) {
  N.rank = new Map(); N.pen = new Map(); N.major = null;
  const deg = N.edges.length;
  if (N.ring) {
    for (const L of N.inLinks) N.rank.set(L, L.edge.ring ? 1 : 0);
  } else if (deg <= 2) {
    for (const L of N.inLinks) N.rank.set(L, 1);
  } else {
    const pairs = [];
    const es = N.edges;
    for (let i = 0; i < es.length; i++) for (let j = i + 1; j < es.length; j++) {
      const di = edgeDirAt(es[i], N), dj = edgeDirAt(es[j], N);
      const ang = Math.acos(clamp(di.x * dj.x + di.y * dj.y, -1, 1));
      const score = edgeImp(es[i]) + edgeImp(es[j]) + (ang > 2.3 ? 10000 : ang * 1000);
      pairs.push({ a: es[i], b: es[j], score });
    }
    pairs.sort((p, q) => q.score - p.score);
    const pk = pairs[N.majorPick % pairs.length];
    N.major = [pk.a, pk.b];
    N.majorCount = pairs.length;
    for (const L of N.inLinks) N.rank.set(L, (L.edge === pk.a || L.edge === pk.b) ? 1 : 0);
  }
  for (const L of N.inLinks) {
    const r = N.rank.get(L);
    let p = 0;
    if (deg >= 3 || N.ring) {
      if (N.ctl === 'light') p = 9;
      else if (N.ctl === 'allstop') p = 7;
      else if (N.ring) p = r ? 0.5 : 3;
      else p = r ? 0.8 : (N.ctl === 'stop' ? 6 : 4);
    }
    N.pen.set(L, p);
  }
}

function computePhases(N) {
  N.phases = [];
  if (N.ctl !== 'light') { N.light = null; return; }
  const es = N.edges.filter(e => N.inLinks.some(L => L.edge === e));
  es.sort((a, b) => edgeImp(b) - edgeImp(a));
  const used = new Set();
  for (const e of es) {
    if (used.has(e)) continue;
    used.add(e);
    const g = [e];
    const d = edgeDirAt(e, N);
    let best = null, bestA = 2.3;
    for (const o of es) {
      if (used.has(o)) continue;
      const d2 = edgeDirAt(o, N);
      const a = Math.acos(clamp(d.x * d2.x + d.y * d2.y, -1, 1));
      if (a > bestA) { bestA = a; best = o; }
    }
    if (best) { used.add(best); g.push(best); }
    N.phases.push(g);
  }
  if (!N.light || N.light.phase >= N.phases.length) N.light = { phase: 0, stage: 'G', t: 0 };
}

function lightState(N, L) {
  const lt = N.light;
  if (!lt || N.ctl !== 'light') return 'G';
  if (!N.phases[lt.phase] || !N.phases[lt.phase].includes(L.edge)) return 'R';
  return lt.stage === 'G' ? 'G' : lt.stage === 'Y' ? 'Y' : 'R';
}

// ---------- Neuaufbau ----------
function netRebuild() {
  const dirtyNodes = new Set([...Net.dirty].filter(N => !N.deleted));
  Net.dirty.clear();
  const dirtyEdges = new Set();
  for (const N of dirtyNodes) for (const e of N.edges) dirtyEdges.add(e);
  for (const e of dirtyEdges) { edgeProps(e); if (e.geomDirty) edgeGeom(e); }
  for (const N of dirtyNodes) computeTrims(N);
  for (const e of dirtyEdges) { fixTrims(e); buildLinks(e); }
  // Knoten an beiden Enden geaenderter Kanten neu berechnen
  const rebuildNodes = new Set(dirtyNodes);
  for (const e of dirtyEdges) { rebuildNodes.add(e.A); rebuildNodes.add(e.B); }
  Net.links = []; Net.lanes = [];
  for (const e of Net.edges.values()) {
    for (const L of [e.linkF, e.linkB]) {
      if (!L) continue;
      L.id = Net.links.length; Net.links.push(L);
      for (const ln of L.allLanes) Net.lanes.push(ln);
    }
  }
  for (const N of rebuildNodes) if (!N.deleted) buildNode(N);
  processTransfers();
  Net.rev++;
  if (typeof Sim !== 'undefined') Sim.onNetChanged(rebuildNodes);
}

function processTransfers() {
  for (const tr of Net.transfers) {
    const { old, uSplit, e1, e2 } = tr;
    for (const [L, dir] of [[old.linkF, 1], [old.linkB, -1]]) {
      if (!L) continue;
      for (const ln of L.allLanes) {
        for (const v of ln.vehicles) {
          if (v.dead) continue;
          const u = dir > 0 ? v.s : old.len - v.s;
          const tgtE = u < uSplit ? e1 : e2;
          if (!Net.edges.has(tgtE.id)) { v.kill = true; continue; }
          const NL = dir > 0 ? tgtE.linkF : tgtE.linkB;
          if (!NL) { v.kill = true; continue; }
          const tgtLane = ln.turn ? (tgtE === (dir > 0 ? e2 : e1) && NL.turnLane ? NL.turnLane : NL.lanes[NL.n - 1]) : NL.lanes[Math.min(ln.idx, NL.n - 1)];
          let ns;
          if (dir > 0) ns = tgtE === e1 ? u : u - uSplit;
          else ns = tgtE === e2 ? old.len - u : uSplit - u;
          v.lane = tgtLane; v.s = clamp(ns, tgtLane.s0, tgtLane.s1); v.committed = null;
          tgtLane.vehicles.push(v);
        }
        ln.vehicles = [];
      }
    }
  }
  Net.transfers = [];
}

// ---------- Auswahl / Snapping ----------
function pickNode(x, y, r) {
  let best = null, bd = r;
  for (const N of Net.nodes.values()) {
    const rr = N.town ? Math.max(r, 30) : r;
    const d = Math.hypot(N.x - x, N.y - y);
    if (d < rr && (!best || d < bd)) { best = N; bd = d; }
  }
  return best;
}

function pickEdge(x, y, r, filter) {
  let best = null;
  for (const e of Net.edges.values()) {
    if (filter && !filter(e)) continue;
    const bb = e.bb, pad = r + e.hw;
    if (x < bb.x0 - pad || x > bb.x1 + pad || y < bb.y0 - pad || y > bb.y1 + pad) continue;
    for (let i = 0; i < e.n; i++) {
      const q = distPointSeg(x, y, e.px[i], e.py[i], e.px[i + 1], e.py[i + 1]);
      const d = Math.max(0, q.d - e.hw * 0.6);
      if (d < r && (!best || d < best.d)) {
        const u = (i + q.t) * e.step;
        best = { edge: e, d, u, t: edgeTAtU(e, u), x: lerp(e.px[i], e.px[i + 1], q.t), y: lerp(e.py[i], e.py[i + 1], q.t) };
      }
    }
  }
  return best;
}

function snapPoint(x, y, scale, opts) {
  const r = Math.max(4, 14 / scale);
  const N = pickNode(x, y, r);
  if (N) return { type: 'node', node: N, x: N.x, y: N.y };
  const pe = pickEdge(x, y, Math.max(3, 10 / scale), e => !e.ring);
  if (pe) {
    if (pe.u < 8) return { type: 'node', node: pe.edge.A, x: pe.edge.A.x, y: pe.edge.A.y };
    if (pe.u > pe.edge.len - 8) return { type: 'node', node: pe.edge.B, x: pe.edge.B.x, y: pe.edge.B.y };
    return { type: 'edge', edge: pe.edge, t: pe.t, u: pe.u, x: pe.x, y: pe.y };
  }
  return { type: 'free', x, y };
}

// ---------- Bauoperationen ----------
function splitEdgeAt(e, t) {
  const [g1, g2] = qSplit(e.A, e.c, e.B, t);
  const X = addNode(g1[2].x, g1[2].y);
  const uSplit = edgeUAtT(e, t);
  const spec = edgeSpec(e);
  const e1 = addEdge(e.A, X, g1[1], spec);
  const e2 = addEdge(X, e.B, g2[1], spec);
  e1.turnB = e.turnB; e2.turnF = e.turnF;
  e1.accidents = e2.accidents = Math.round(e.accidents / 2);
  Net.transfers.push({ old: e, uSplit, e1, e2 });
  // alte Kante entfernen, Fahrzeuge bleiben fuer den Transfer erhalten
  Net.edges.delete(e.id);
  for (const N of [e.A, e.B]) {
    const i = N.edges.indexOf(e);
    if (i >= 0) N.edges.splice(i, 1);
    Net.dirty.add(N);
  }
  for (const L of [e.linkF, e.linkB]) if (L) { L.dead = true; for (const ln of L.allLanes) ln.alive = false; }
  return X;
}

function resolveSnap(sn) {
  if (sn.type === 'node' && !sn.node.deleted) return sn.node;
  if (sn.type === 'edge') {
    let e = sn.edge, t = sn.t;
    if (!Net.edges.has(e.id)) {
      const pe = pickEdge(sn.x, sn.y, 3, x => !x.ring);
      if (!pe) return addNode(sn.x, sn.y);
      e = pe.edge; t = pe.t;
      if (pe.u < 6) return e.A;
      if (pe.u > e.len - 6) return e.B;
    }
    return splitEdgeAt(e, t);
  }
  const N = pickNode(sn.x, sn.y, 2);
  return N || addNode(sn.x, sn.y);
}

function buildRoad(s0, ctrl, s1, spec, level) {
  const p0 = { x: s0.x, y: s0.y }, p1 = { x: s1.x, y: s1.y };
  const c = ctrl ? { x: ctrl.x, y: ctrl.y } : { x: (p0.x + p1.x) / 2, y: (p0.y + p1.y) / 2 };
  const approxLen = Math.hypot(c.x - p0.x, c.y - p0.y) + Math.hypot(p1.x - c.x, p1.y - c.y);
  if (approxLen < 10) return { ok: false, msg: 'Straße zu kurz' };
  if (s0.type === 'node' && s1.type === 'node' && s0.node === s1.node) return { ok: false, msg: 'Start = Ende' };
  // Kreuzungen sammeln (nur ebenerdig)
  const crosses = [];
  if (level === 0) {
    const NS = Math.max(8, Math.ceil(approxLen / 2));
    const pts = [];
    for (let i = 0; i <= NS; i++) pts.push(qPoint(p0, c, p1, i / NS));
    let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
    for (const p of pts) { bx0 = Math.min(bx0, p.x); by0 = Math.min(by0, p.y); bx1 = Math.max(bx1, p.x); by1 = Math.max(by1, p.y); }
    for (const e of Net.edges.values()) {
      if (e.level !== 0) continue;
      if (e.bb.x1 < bx0 - 2 || e.bb.x0 > bx1 + 2 || e.bb.y1 < by0 - 2 || e.bb.y0 > by1 + 2) continue;
      for (let i = 0; i < NS; i++) for (let j = 0; j < e.n; j++) {
        const r = segIntersect(pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y, e.px[j], e.py[j], e.px[j + 1], e.py[j + 1]);
        if (!r) continue;
        const x = lerp(pts[i].x, pts[i + 1].x, r.t), y = lerp(pts[i].y, pts[i + 1].y, r.t);
        if (Math.hypot(x - p0.x, y - p0.y) < 5 || Math.hypot(x - p1.x, y - p1.y) < 5) continue;
        if (e.ring) return { ok: false, msg: 'Kreuzt einen Kreisverkehr' };
        crosses.push({ t: (i + r.t) / NS, e, u: (j + r.u) * e.step, x, y });
      }
    }
  }
  crosses.sort((a, b) => a.t - b.t);
  const cr2 = [];
  for (const cr of crosses) {
    const last = cr2[cr2.length - 1];
    if (last && Math.hypot(cr.x - last.x, cr.y - last.y) < 8) continue;
    cr2.push(cr);
  }
  const S = resolveSnap(s0);
  const seq = [S], ts = [0];
  for (const cr of cr2) {
    let X;
    let e = cr.e, u = cr.u;
    if (!Net.edges.has(e.id)) {
      const pe = pickEdge(cr.x, cr.y, 3, x => x.level === 0 && !x.ring);
      if (!pe) continue;
      e = pe.edge; u = pe.u;
    }
    if (u < 9) X = e.A;
    else if (u > e.len - 9) X = e.B;
    else X = splitEdgeAt(e, edgeTAtU(e, u));
    if (seq.includes(X)) continue;
    seq.push(X); ts.push(cr.t);
  }
  const E = resolveSnap(s1);
  if (E === S) { netRebuild(); return { ok: false, msg: 'Start = Ende' }; }
  seq.push(E); ts.push(1);
  let rem = [p0, c, p1], prevT = 0;
  const made = [];
  for (let k = 1; k < seq.length; k++) {
    const t = ts[k];
    let g;
    if (k === seq.length - 1) g = rem;
    else {
      const loc = (t - prevT) / (1 - prevT);
      const sp = qSplit(rem[0], rem[1], rem[2], clamp(loc, 0.001, 0.999));
      g = sp[0]; rem = sp[1];
    }
    prevT = t;
    const A = seq[k - 1], B = seq[k];
    if (A === B) continue;
    if (Math.hypot(A.x - B.x, A.y - B.y) < 2) continue;
    const dup = A.edges.find(e => ((e.A === A && e.B === B) || (e.A === B && e.B === A)) &&
      Math.hypot(e.c.x - g[1].x, e.c.y - g[1].y) < 6);
    if (dup) continue;
    // Kontrollpunkt an tatsaechliche Endpunkte anpassen
    const cc = { x: g[1].x + ((A.x - g[0].x) + (B.x - g[2].x)) / 2, y: g[1].y + ((A.y - g[0].y) + (B.y - g[2].y)) / 2 };
    made.push(addEdge(A, B, cc, Object.assign({}, spec, { level })));
  }
  netRebuild();
  return { ok: true, end: E, edges: made };
}

function buildRoundabout(N) {
  if (N.ring) return { ok: false, msg: 'Ist bereits Teil eines Kreisverkehrs' };
  if (N.town) return { ok: false, msg: 'Nicht im Ortszentrum möglich' };
  if (N.edges.length < 2) return { ok: false, msg: 'Mindestens 2 Straßen nötig' };
  if (N.edges.some(e => e.level !== 0)) return { ok: false, msg: 'Nur bei ebenerdigen Straßen' };
  const maxHw = Math.max(...N.edges.map(e => e.hw));
  const twoLane = N.edges.some(e => Math.max(e.nF, e.nB) >= 2);
  const R = 13 + maxHw * 1.2 + (twoLane ? 4 : 0);
  for (const e of N.edges) if (e.len < R + 14) return { ok: false, msg: 'Anschlussstraßen zu kurz für Kreisverkehr' };
  const ringId = Net.nextId++;
  const cx = N.x, cy = N.y;
  const ringNodes = [];
  for (const e of [...N.edges]) {
    let u;
    const step = 0.5;
    if (e.A === N) { u = 0; while (u < e.len) { const p = edgeSample(e, u); if (Math.hypot(p.x - cx, p.y - cy) >= R) break; u += step; } }
    else { u = e.len; while (u > 0) { const p = edgeSample(e, u); if (Math.hypot(p.x - cx, p.y - cy) >= R) break; u -= step; } }
    const X = splitEdgeAt(e, edgeTAtU(e, u));
    // inneres Stueck entfernen
    for (const ie of [...X.edges]) if (ie.A === N || ie.B === N) removeEdge(ie);
    ringNodes.push(X);
  }
  removeNode(N);
  for (const X of ringNodes) {
    const a = Math.atan2(X.y - cy, X.x - cx);
    X.x = cx + Math.cos(a) * R; X.y = cy + Math.sin(a) * R;
    X.ang = a; X.ring = ringId; X.ctl = 'ringnode';
    for (const e of X.edges) e.geomDirty = true;
  }
  ringNodes.sort((a, b) => a.ang - b.ang);
  const list = [];
  for (let i = 0; i < ringNodes.length; i++) {
    const a = ringNodes[i], b = ringNodes[(i + 1) % ringNodes.length];
    list.push(a);
    let gap = b.ang - a.ang; if (i === ringNodes.length - 1) gap += TAU;
    if (ringNodes.length === 1) gap = TAU;
    const extra = Math.max(0, Math.ceil(gap / 1.6) - 1);
    for (let k = 1; k <= extra; k++) {
      const ang = a.ang + gap * k / (extra + 1);
      const M = addNode(cx + Math.cos(ang) * R, cy + Math.sin(ang) * R, { ring: ringId, ctl: 'ringnode' });
      M.ang = ang;
      list.push(M);
    }
  }
  const spec = { nF: twoLane ? 2 : 1, nB: 0, speed: 30, median: 0, level: 0, ring: ringId };
  for (let i = 0; i < list.length; i++) {
    const to = list[i], from = list[(i + 1) % list.length];
    let d = from.ang - to.ang; while (d <= 0) d += TAU;
    const mid = to.ang + d / 2;
    const k = R / Math.cos(d / 2);
    addEdge(from, to, { x: cx + Math.cos(mid) * k, y: cy + Math.sin(mid) * k }, spec);
  }
  Net.rings.set(ringId, { cx, cy, R, w: spec.nF * LANE_W });
  netRebuild();
  return { ok: true };
}

function upgradeEdge(e, spec) {
  const same = e.nF === spec.nF && e.nB === spec.nB && e.kmh === spec.speed;
  if (e.ring) {
    e.nF = clamp(spec.nF, 1, 2); e.kmh = Math.min(spec.speed, 50);
  } else if (same && e.nB === 0) {
    // Einbahnstrasse umdrehen
    const A = e.A; e.A = e.B; e.B = A;
    const t = e.turnF; e.turnF = e.turnB; e.turnB = t;
    killLink(e.linkF); killLink(e.linkB); e.linkF = e.linkB = null;
    e.geomDirty = true;
  } else {
    e.nF = spec.nF; e.nB = spec.nB; e.kmh = spec.speed;
    e.median = spec.nB > 0 ? (spec.median || 0) : 0;
    if (e.nB === 0) { killLink(e.linkB); e.linkB = null; e.turnB = false; }
  }
  Net.dirty.add(e.A); Net.dirty.add(e.B);
  netRebuild();
}

function toggleTurnLane(e, nearB) {
  if (nearB) { if (e.nF === 0) return false; e.turnF = !e.turnF; }
  else { if (e.nB === 0) return false; e.turnB = !e.turnB; }
  Net.dirty.add(e.A); Net.dirty.add(e.B);
  netRebuild();
  return nearB ? e.turnF : e.turnB;
}

function setNodeControl(N, ctl) {
  N.ctl = ctl;
  Net.dirty.add(N);
  netRebuild();
}

// ---------- Speichern / Laden ----------
function netSerialize() {
  return {
    nodes: [...Net.nodes.values()].map(N => ({ id: N.id, x: N.x, y: N.y, ctl: N.ctl, town: N.town ? N.town.id : null, ring: N.ring, ang: N.ang, mp: N.majorPick, acc: N.accidents })),
    edges: [...Net.edges.values()].map(e => ({ id: e.id, a: e.A.id, b: e.B.id, c: e.c, nF: e.nF, nB: e.nB, kmh: e.kmh, median: e.median, level: e.level, ring: e.ring, tF: e.turnF, tB: e.turnB, acc: e.accidents })),
    rings: [...Net.rings.entries()],
    nextId: Net.nextId,
  };
}

function netDeserialize(d) {
  netReset();
  const map = new Map();
  for (const n of d.nodes) {
    const N = addNode(n.x, n.y, { ctl: n.ctl, ring: n.ring || 0, ang: n.ang, majorPick: n.mp || 0, accidents: n.acc || 0 });
    Net.nodes.delete(N.id); N.id = n.id; Net.nodes.set(N.id, N);
    if (n.town) {
      const [cx, cy] = n.town.split(':').map(Number);
      const t = Terrain.townAt(cx, cy);
      if (t) { t.node = N; N.town = t; }
    }
    map.set(n.id, N);
  }
  for (const e of d.edges) {
    const A = map.get(e.a), B = map.get(e.b);
    if (!A || !B) continue;
    const E = addEdge(A, B, e.c, { nF: e.nF, nB: e.nB, speed: e.kmh, median: e.median, level: e.level, ring: e.ring });
    Net.edges.delete(E.id); E.id = e.id; Net.edges.set(E.id, E);
    E.turnF = !!e.tF; E.turnB = !!e.tB; E.accidents = e.acc || 0;
  }
  for (const [k, v] of (d.rings || [])) Net.rings.set(k, v);
  Net.nextId = Math.max(d.nextId || 1, Net.nextId);
  netRebuild();
}
