'use strict';
// ---------- Verkehrssimulation ----------
const MAX_VEH = 2600;
const CAR_COLORS = ['#ececec', '#2b2b2b', '#c0392b', '#2c6fbb', '#7f8c8d', '#e5c33b', '#2e8b57', '#7d4ba0', '#d35400',
  '#b8c2cc', '#1a3d6b', '#7a1f1f', '#4f6d7a', '#f0f0e8'];
const TRUCK_COLORS = ['#d8d2c4', '#5d6d7e', '#a04000', '#1e8449', '#e8e2d0'];

const Sim = {
  vehicles: [], time: 0, tick: 0, nextVid: 1, demand: 1, errMul: 1, speed: 1, paused: false,
  routes: new Map(), epoch: 0, nextEpoch: 0, travel: null, lightNodes: [],
  homes: [], dests: [], housesDirty: true, pending: [],
  stats: null, accidents: [], history: [], lastHist: 0, lastStat: 0,
  flowIdx: 1, jam: 0, histTrips: 0, histAcc: 0, onAccident: null,

  reset() {
    this.vehicles = []; this.time = 0; this.tick = 0; this.routes = new Map(); this.epoch++; this.pending = [];
    this.stats = { trips: 0, accidents: 0, lost: 0, gaveUp: 0, towed: 0, tripTime: 0 };
    this.accidents = []; this.history = []; this.lastHist = 0; this.lastStat = 0; this.flowIdx = 1; this.jam = 0;
    this.histTrips = 0; this.histAcc = 0; this.housesDirty = true;
  },

  onNetChanged(nodes) {
    for (const N of nodes) if (!N.deleted) N.occ = new Set();
    this.lightNodes = [...Net.nodes.values()].filter(N => N.ctl === 'light' && N.phases.length);
    this.epoch++; this.routes = new Map(); this.travel = null;
    if (this.housesDirty) refreshHouses();
    for (const v of this.vehicles) {
      if (v.dead) continue;
      if (v.kill || !v.dest.att) { removeVehicle(v); this.stats.lost++; continue; }
      if (v.move) {
        if (v.move.node.deleted) { removeVehicle(v); continue; }
        if (nodes.has(v.move.node)) v.move.node.occ.add(v);
      } else if (v.lane) {
        if (!v.lane.alive) { removeVehicle(v); continue; }
        if (v.committed) v.committed.node.occ.delete(v);
        v.committed = null;
        v.nextLink = null;
        setNext(v);
      }
    }
    this.vehicles = this.vehicles.filter(v => !v.dead);
  },

  step(dt) {
    this.time += dt; this.tick++;
    if (this.housesDirty) refreshHouses();
    if (this.time >= this.nextEpoch) { this.epoch++; this.nextEpoch = this.time + 4; this.travel = null; }
    updateLights(dt);
    spawnStep(dt);
    sortLanes();
    for (const v of this.vehicles) if (!v.dead && v.lane && !v.crashed && !v.committed && !v.exitHere && v.lcCool <= 0 && ((v.id + this.tick) % 4) === 0) tryLaneChange(v);
    for (const ln of Net.lanes) { const a = ln.vehicles; for (let i = 0; i < a.length; i++) a[i].idx = i; }
    for (const v of this.vehicles) if (!v.dead) computeAccel(v);
    for (const v of this.vehicles) if (!v.dead) integrate(v, dt);
    checkCollisions();
    for (const v of this.vehicles) {
      if (v.dead) continue;
      if (v.kill) { removeVehicle(v); this.stats.lost++; }
      else if (v.crashed && this.time > v.crashed) { removeVehicle(v); this.stats.towed++; }
      else if (!v.crashed && v.waitT > 200) { removeVehicle(v); this.stats.gaveUp++; }
      else if (v.lost && this.time - v.lostT > 45) { removeVehicle(v); this.stats.lost++; }
    }
    if (this.tick % 30 === 0) this.vehicles = this.vehicles.filter(v => !v.dead);
    if (this.time - this.lastStat >= 1) { this.lastStat = this.time; updateStats(); }
    if (this.time - this.lastHist >= 5) { this.lastHist = this.time; pushHistory(); }
  },
};
Sim.reset();

function refreshHouses() {
  Sim.housesDirty = false;
  const homes = [], dests = [];
  for (const t of Terrain.towns.values()) {
    if (!t || !t.houses) continue;
    for (const h of t.houses) {
      if (!h.att) continue;
      dests.push(h);
      if (h.kind === 'home') homes.push(h);
    }
  }
  Sim.homes = homes; Sim.dests = dests;
}

function newVehicle(lane, dest, origin) {
  const r = Math.random;
  const truck = r() < 0.08;
  return {
    id: Sim.nextVid++, lane, move: null, s: lane.s0, v: 0, acc: 0, dest, origin, truck,
    len: truck ? 12 : 4.3 + r() * 0.7, w: truck ? 2.5 : 1.85,
    drv: truck ? { a: 1.0, b: 2.4, T: 1.4 + r() * 0.4, s0: 2.2, vf: 0.82 + r() * 0.08, gap: 1.2, vmax: 25 }
      : { a: 1.9 + r() * 0.8, b: 2.8, T: 0.8 + r() * 0.6, s0: 1.6, vf: 0.92 + r() * 0.2, gap: 0.75 + r() * 0.5, vmax: 50 },
    color: truck ? TRUCK_COLORS[Math.floor(r() * TRUCK_COLORS.length)] : CAR_COLORS[Math.floor(r() * CAR_COLORS.length)],
    nextLink: null, nextMove: null, exitHere: false, arriveS: 0, committed: null, stopped: false, stopT: 0, waitT: 0,
    err: false, lcOff: 0, lcCool: 1 + r() * 2, crashed: 0, spawnT: Sim.time, dist: 0, lost: false, lostT: 0,
    dead: false, kill: false, idx: 0, totalWait: 0,
  };
}

function removeFromLane(v) {
  const a = v.lane.vehicles, i = a.indexOf(v);
  if (i >= 0) a.splice(i, 1);
}

function removeVehicle(v) {
  if (v.dead) return;
  if (v.lane) removeFromLane(v);
  if (v.move) { const i = v.move.vehicles.indexOf(v); if (i >= 0) v.move.vehicles.splice(i, 1); v.move.node.occ.delete(v); }
  if (v.committed) v.committed.node.occ.delete(v);
  v.dead = true;
}

function finishTrip(v) {
  Sim.stats.trips++;
  Sim.stats.tripTime += Sim.time - v.spawnT;
  removeVehicle(v);
}

// ---------- Routing (Kosten bis zur Zielstrasse) ----------
function travelTimes() {
  if (Sim.travel && Sim.travel.length === Net.links.length) return Sim.travel;
  const t = new Float64Array(Net.links.length);
  for (const L of Net.links) t[L.id] = (Math.max(L.len, 1) + 6) / Math.max(1.2, Math.min(L.avgV, L.speed));
  Sim.travel = t;
  return t;
}

function routeCost(E) {
  const c = Sim.routes.get(E.id);
  if (c && c.epoch === Sim.epoch) return c.cost;
  const travel = travelTimes();
  const cost = new Float64Array(Net.links.length).fill(Infinity);
  const h = new MinHeap();
  for (const L of [E.linkF, E.linkB]) if (L) { cost[L.id] = travel[L.id] * 0.5; h.push(cost[L.id], L); }
  while (h.size) {
    const L = h.pop(), cc = h.topKey;
    if (cc > cost[L.id]) continue;
    const N = L.from;
    const preds = N.trans.get(L);
    if (!preds) continue;
    for (const P of preds) {
      const nc = cc + travel[P.id] + (N.pen.get(P) || 0);
      if (nc < cost[P.id]) { cost[P.id] = nc; h.push(nc, P); }
    }
  }
  Sim.routes.set(E.id, { epoch: Sim.epoch, cost });
  return cost;
}

function destS(L, D) { return L.dir > 0 ? D.att.u : L.edge.len - D.att.u; }

function chooseNext(v, L) {
  const outs = L.to.transOut.get(L);
  if (!outs || !outs.length) return null;
  let best = null, bc = Infinity;
  if (!v.lost && v.dest.att) {
    const cost = routeCost(v.dest.att.edge);
    for (const o of outs) {
      const c = cost[o.id];
      if (c < Infinity) { const cc = c * (1 + 0.06 * Math.random()); if (cc < bc) { bc = cc; best = o; } }
    }
  }
  if (!best) {
    if (!v.lost) { v.lost = true; v.lostT = Sim.time; }
    best = outs[Math.floor(Math.random() * outs.length)];
  }
  return best;
}

function setNext(v) {
  const lane = v.lane, L = lane.link;
  v.exitHere = false;
  const D = v.dest;
  if (!D.att) { v.kill = true; return; }
  if (L.edge === D.att.edge) {
    const sd = destS(L, D);
    if (sd >= v.s - 0.5) { v.exitHere = true; v.arriveS = clamp(sd, lane.s0, lane.s1 - 0.5); v.nextLink = null; v.nextMove = null; return; }
  }
  const outs = L.to.transOut.get(L) || [];
  if (!v.nextLink || v.nextLink.dead || !outs.includes(v.nextLink)) v.nextLink = chooseNext(v, L);
  v.nextMove = v.nextLink ? (lane.moves.find(m => m.outLink === v.nextLink) || null) : null;
}

function rollErr(v) {
  const L = v.lane.link, N = L.to;
  const r = N.rank.get(L) || 0;
  let p = 0;
  if (N.edges.length >= 3 || N.ring) {
    if (N.ctl === 'light') p = 0.0015;
    else if (N.ctl === 'rvl') p = 0.006;
    else if (N.ring) p = r ? 0 : 0.003;
    else if (!r) {
      const majV = N.major ? Math.max(N.major[0].kmh, N.major[1].kmh) : 50;
      p = (N.ctl === 'stop' ? 0.004 : 0.011) * majV / 50;
    } else p = 0.002;
  }
  v.err = Math.random() < p * Sim.errMul;
}

// ---------- Erzeugung: Fahrten von Haus zu Haus ----------
function pickDest(h) {
  const D = Sim.dests;
  if (D.length < 2) return null;
  let best = null, sum = 0;
  const cand = [];
  for (let i = 0; i < 8; i++) {
    const d = D[Math.floor(Math.random() * D.length)];
    if (d === h) continue;
    const dist = Math.hypot(d.x - h.x, d.y - h.y);
    if (dist < 60) continue;
    const w = d.weight / (1 + dist / 1500);
    cand.push([d, w]); sum += w;
  }
  let r = Math.random() * sum;
  for (const [d, w] of cand) { r -= w; if (r <= 0) { best = d; break; } }
  return best || (cand.length ? cand[cand.length - 1][0] : null);
}

function spawnStep(dt) {
  const H = Sim.homes;
  if (H.length && Sim.dests.length > 1) {
    const x = H.length * Sim.demand / 150 * dt;
    let k = Math.floor(x) + (Math.random() < x - Math.floor(x) ? 1 : 0);
    while (k-- > 0) {
      const h = H[Math.floor(Math.random() * H.length)];
      const d = pickDest(h);
      if (d && Sim.pending.length < 300) Sim.pending.push({ h, d, t: Sim.time });
    }
  }
  if (!Sim.pending.length) return;
  const keep = [];
  let tries = 0;
  for (const p of Sim.pending) {
    if (tries++ > 25 || Sim.vehicles.length >= MAX_VEH) { keep.push(p); continue; }
    if (!p.h.att || !p.d.att) continue;
    const r = trySpawn(p.h, p.d);
    if (r === 'wait' && Sim.time - p.t < 90) keep.push(p);
  }
  Sim.pending = keep;
}

function startChoice(h, D) {
  const E = h.att.edge, cost = routeCost(D.att.edge);
  let best = null;
  for (const L of [E.linkF, E.linkB]) {
    if (!L) continue;
    const ln = L.lanes[0];
    const s = clamp(L.dir > 0 ? h.att.u : E.len - h.att.u, ln.s0 + 1, ln.s1 - 2);
    let c;
    if (E === D.att.edge) { const sd = destS(L, D); if (sd > s + 5) c = (sd - s) / L.speed; }
    if (c === undefined) {
      let mo = Infinity;
      for (const o of (L.to.transOut.get(L) || [])) mo = Math.min(mo, cost[o.id]);
      c = (ln.s1 - s) / Math.max(2, L.avgV) + (L.to.pen.get(L) || 0) + mo;
    }
    if (c < Infinity && (!best || c < best.c)) best = { L, s, c };
  }
  return best;
}

function trySpawn(h, D) {
  const ch = startChoice(h, D);
  if (!ch) return 'fail';
  const lane = ch.L.lanes[0], s = ch.s;
  const a = lane.vehicles;
  const i = lowerBound(a, s);
  const lead = a[i], foll = a[i - 1];
  if (lead && lead.s - lead.len - s < 4) return 'wait';
  if (foll && s - 4.8 - foll.s < 3 + foll.v * 1.3) return 'wait';
  const v = newVehicle(lane, D, h);
  v.s = s; v.v = 0;
  a.splice(i, 0, v);
  Sim.vehicles.push(v);
  setNext(v);
  rollErr(v);
  return 'ok';
}

// ---------- Ampeln ----------
function updateLights(dt) {
  for (const N of Sim.lightNodes) {
    const lt = N.light;
    if (!lt) continue;
    lt.t += dt;
    if (lt.stage === 'G') {
      const cur = N.phases[lt.phase] || [];
      let demOther = false;
      for (const L of N.inLinks) {
        if (cur.includes(L.edge)) continue;
        for (const ln of L.allLanes) {
          const a = ln.vehicles;
          if (a.length && ln.s1 - a[a.length - 1].s < 70) demOther = true;
        }
      }
      const gap = Sim.time - (lt.lastPass || 0);
      if (demOther && ((lt.t > 7 && gap > 3.5) || lt.t > 32)) { lt.stage = 'Y'; lt.t = 0; }
    } else if (lt.stage === 'Y') {
      if (lt.t > 3) { lt.stage = 'AR'; lt.t = 0; }
    } else if (lt.t > 1.8) {
      lt.phase = (lt.phase + 1) % N.phases.length; lt.stage = 'G'; lt.t = 0;
    }
  }
}

// ---------- Fahrzeugfolge (IDM) ----------
function idmAcc(v, v0, gap, vl) {
  const p = v.drv;
  v0 = Math.max(v0, 0.5);
  const sp = v.v;
  const ss = p.s0 + Math.max(0, sp * p.T + sp * (sp - vl) / (2 * Math.sqrt(p.a * p.b)));
  const g = Math.max(gap, 0.05);
  const r = sp / v0;
  return p.a * (1 - r * r * r * r - (ss / g) * (ss / g));
}
function freeAcc(v, v0) { const r = v.v / Math.max(v0, 0.5); return v.drv.a * (1 - r * r * r * r); }

function tReach(u, D, vmax) {
  if (D <= 0) return 0;
  const a = Math.max(0.6, u.drv.a), vv = u.v;
  vmax = Math.max(vmax || 99, 1);
  if (vv >= vmax - 0.3) return D / Math.max(vv, 0.1);
  const t1 = (vmax - vv) / a, d1 = (vv + vmax) / 2 * t1;
  if (d1 >= D) return (-vv + Math.sqrt(vv * vv + 2 * a * D)) / a;
  return t1 + (D - d1) / vmax;
}
function laneV0(v, L) { return Math.min(L.speed * v.drv.vf, L.edge.curveV, v.drv.vmax); }
function uV0(u) { return u.lane ? laneV0(u, u.lane.link) : u.move ? u.move.vmax : 15; }

function computeAccel(v) {
  if (v.crashed) { v.acc = 0; v.v = 0; return; }
  let acc;
  if (v.lane) {
    const lane = v.lane, L = lane.link;
    const v0 = laneV0(v, L);
    acc = freeAcc(v, v0);
    const arr = lane.vehicles;
    const distEnd = lane.s1 - v.s;
    if (v.idx + 1 < arr.length && arr[v.idx + 1] !== v) {
      const ld = arr[v.idx + 1];
      acc = Math.min(acc, idmAcc(v, v0, ld.s - ld.len - v.s, ld.v));
    } else if (distEnd < 160 && !v.exitHere) {
      const lo = lane.lastOut;
      if (lo && !lo.dead && lo.move) acc = Math.min(acc, idmAcc(v, v0, distEnd + lo.s - lo.len, lo.v));
      const m = v.nextMove;
      if (m) {
        let q = null;
        for (const u of m.vehicles) if (!q || u.s < q.s) q = u;
        if (q) acc = Math.min(acc, idmAcc(v, v0, distEnd + q.s - q.len, q.v));
        else {
          const q2 = m.outLane.vehicles[0];
          if (q2) acc = Math.min(acc, idmAcc(v, v0, distEnd + m.len + q2.s - m.outLane.s0 - q2.len, q2.v));
        }
      }
    }
    if (v.exitHere) {
      // in die Einfahrt abbiegen: auf ~15 km/h abbremsen
      const d = v.arriveS - v.s;
      if (v.v > 4.5) { const need = (v.v * v.v - 20) / (2 * Math.max(d, 1)); if (need > 0.6) acc = Math.min(acc, -need); }
    } else if (distEnd < 220) {
      const m = v.nextMove;
      if (!m) {
        acc = Math.min(acc, idmAcc(v, v0, distEnd + 0.5, 0));
        if (distEnd < 15 && v.v < 0.5 && v.waitT > 3) forceAnyMove(v);
      } else {
        const vt = Math.min(m.vmax, laneV0(v, m.outLink) + 1);
        if (v.v > vt) {
          const need = (v.v * v.v - vt * vt) / (2 * Math.max(distEnd - 1, 0.5));
          if (need > 0.7) acc = Math.min(acc, -need);
        }
        if (!intersectionOk(v, m, distEnd)) acc = Math.min(acc, idmAcc(v, v0, distEnd + 0.3, 0));
      }
    }
  } else {
    const m = v.move;
    const v0 = Math.min(m.vmax * clamp(v.drv.vf, 0.85, 1.05), v.drv.vmax);
    acc = freeAcc(v, v0);
    let q = null;
    for (const u of m.vehicles) if (u !== v && u.s > v.s && (!q || u.s < q.s)) q = u;
    if (q) acc = Math.min(acc, idmAcc(v, v0, q.s - q.len - v.s, q.v));
    else {
      const ol = m.outLane, q2 = ol.vehicles[0];
      if (q2) acc = Math.min(acc, idmAcc(v, v0, m.len - v.s + q2.s - ol.s0 - q2.len, q2.v));
    }
  }
  v.acc = clamp(acc, -9, v.drv.a);
}

function forceAnyMove(v) {
  const ms = v.lane.moves;
  if (!ms.length) return;
  const m = ms[Math.floor(Math.random() * ms.length)];
  v.nextLink = m.outLink; v.nextMove = m;
}

function commit(v, m) {
  if (v.committed === m) return;
  if (v.committed) v.committed.node.occ.delete(v);
  v.committed = m;
  m.node.occ.add(v);
}

function intersectionOk(v, m, dist) {
  const N = m.node;
  if (v.committed === m) {
    if (dist > 2) {
      for (const u of N.occ) {
        if (u === v || !u.move) continue;
        const c = m.conf.get(u.move);
        if (c && !c.merge && u.s < c.sOther + u.len * 0.5 + 1) {
          if (v.v * v.v / (2 * Math.max(dist - 0.5, 0.3)) < 9.5) return false;
        }
      }
    }
    return true;
  }
  const decide = Math.max(35, v.v * v.v / 3 + 15);
  if (dist > decide) return true;
  if (N.edges.length <= 2 && !N.ring) return true;
  const L = m.inLane.link;
  const rank = N.rank.get(L) || 0;
  let yieldAll = false;
  if (N.ctl === 'light') {
    const st = lightState(N, L);
    if (st === 'R') {
      // Gruenpfeil: nach Halt rechts abbiegen, allen Vorrang gewaehren
      if (!(N.gruen && m.kind === 'R')) return false;
      if (!v.stopped) {
        if (dist < 4.5 && v.v < 0.6) { v.stopped = true; v.stopT = Sim.time; } else return false;
      }
      yieldAll = true;
    } else if (st === 'Y') {
      if (dist < 4 && v.v < 2) {
        if (!mayEnter(v, m, dist, false)) return false;
        commit(v, m);
        return true;
      }
      if (dist > v.v * v.v / 7 + 1.5) return false;
      commit(v, m);
      return true;
    }
  } else if (N.ctl === 'stop' && rank === 0 && !v.stopped) {
    if (dist < 4.5 && v.v < 0.6) { v.stopped = true; v.stopT = Sim.time; } else return false;
  }
  if (!mayEnter(v, m, dist, yieldAll)) return false;
  if (dist < v.v * v.v / 9 + 2.5) commit(v, m);
  return true;
}

function hasPrio(N, u, mu, v, m) {
  if (N.ctl === 'light') {
    if (m.kind === 'U') return true;
    return m.kind === 'L' && mu.kind !== 'L';
  }
  const ru = N.rank.get(mu.inLane.link) || 0, rv = N.rank.get(m.inLane.link) || 0;
  if (ru !== rv) return ru > rv;
  if (N.ring) return false;
  if ((m.kind === 'L' || m.kind === 'U') && mu.kind !== 'L' && mu.kind !== 'U') return true;
  if ((mu.kind === 'L' || mu.kind === 'U') && m.kind !== 'L' && m.kind !== 'U') return false;
  // rechts vor links
  const hv = m.inLane.link.hEnd, hu = mu.inLane.link.hEnd;
  return (-hu.x) * (-hv.y) + (-hu.y) * hv.x > 0.1;
}

function mayEnter(v, m, dist, yieldAll) {
  const N = m.node;
  const ol = m.outLane, q = ol.vehicles[0];
  if (q && q.s - q.len - ol.s0 < v.len + 1 && q.v < 0.8) return false;
  for (const u of m.vehicles) if (u.s < u.len + 1 && u.v < 1) return false;
  const imp = Math.max(0.35, 1 - v.waitT / 60);
  const margin = 0.5 + 1.0 * v.drv.gap * imp + (yieldAll ? 1 : 0);
  const vmV = Math.min(m.vmax, laneV0(v, m.outLink));
  for (const u of N.occ) {
    if (u === v || u.dead) continue;
    const mu = u.move || u.committed;
    if (!mu || mu === m) continue;
    const c = m.conf.get(mu);
    if (!c) continue;
    if (u.move) {
      if (u.crashed || u.s < c.sOther + u.len * 0.5 + 1.5) return false;
    } else {
      const du = u.lane.s1 - u.s;
      if (u.crashed && du < 8) return false;
      if (tReach(u, du + c.sOther, uV0(u)) < tReach(v, dist + c.sSelf + v.len + 1, vmV) + margin) return false;
    }
  }
  if (v.err && !yieldAll) return true;
  const isLight = N.ctl === 'light';
  for (const L of N.inLinks) {
    if (L === m.inLane.link) continue;
    let st = 'G';
    if (isLight) { st = lightState(N, L); if (st === 'R') continue; }
    for (const ln of L.allLanes) {
      const a = ln.vehicles;
      let cnt = 0;
      for (let i = a.length - 1; i >= 0 && cnt < 3; i--) {
        const u = a[i];
        const du = ln.s1 - u.s;
        if (du > 220) break;
        if (u.committed || u.crashed || u.dead || u.exitHere) continue;
        if (u.v < 1.5 && i < a.length - 1 && !a[i + 1].committed) break;
        cnt++;
        const mu = u.nextMove;
        if (!mu) continue;
        const c = m.conf.get(mu);
        if (!c) continue;
        if (!yieldAll && !hasPrio(N, u, mu, v, m)) continue;
        // gegenseitiges Warten (z.B. rechts vor links von allen Seiten) aufloesen: eindeutige Reihenfolge
        if (!yieldAll && u.v < 0.5 && u.waitT > 2 && v.waitT > 2 &&
          (v.waitT > u.waitT + 1 || (Math.abs(v.waitT - u.waitT) <= 1 && v.id < u.id))) continue;
        if (st === 'Y' && du > u.v * u.v / 7 + 1.5) continue;
        const eta = tReach(u, du + c.sOther, Math.min(uV0(u), mu.vmax + 3));
        if (eta < tReach(v, dist + c.sSelf + v.len + 1, vmV) + margin) return false;
      }
    }
  }
  return true;
}

// ---------- Bewegung ----------
function integrate(v, dt) {
  if (v.crashed) return;
  const nv = Math.max(0, v.v + v.acc * dt);
  const ds = (v.v + nv) * 0.5 * dt;
  v.v = nv; v.s += ds; v.dist += ds;
  if (v.v < 0.5) { v.waitT += dt; v.totalWait += dt; }
  if (v.lcOff) { const d = 1.5 * dt; v.lcOff = Math.abs(v.lcOff) <= d ? 0 : v.lcOff - Math.sign(v.lcOff) * d; }
  if (v.lcCool > 0) v.lcCool -= dt;
  if (v.lane) {
    const lane = v.lane;
    if (v.exitHere && v.s >= v.arriveS) { finishTrip(v); return; }
    if (v.s >= lane.s1) {
      if (v.exitHere) { finishTrip(v); return; }
      let m = v.nextMove;
      if (!m) {
        if (lane.moves.length) { m = lane.moves[Math.floor(Math.random() * lane.moves.length)]; v.nextLink = m.outLink; }
        else { removeVehicle(v); Sim.stats.lost++; return; }
      }
      const over = v.s - lane.s1;
      removeFromLane(v);
      lane.lastOut = v;
      commit(v, m);
      const N = m.node;
      N.waitAvg += (v.waitT - N.waitAvg) * 0.04; N.thrCnt++;
      if (N.light) N.light.lastPass = Sim.time;
      lane.link.flowCnt++;
      v.lane = null; v.move = m; v.s = over; m.vehicles.push(v); v.lcOff = 0;
    }
  } else if (v.move) {
    const m = v.move;
    if (v.s >= m.len) {
      const over = v.s - m.len;
      const i = m.vehicles.indexOf(v);
      if (i >= 0) m.vehicles.splice(i, 1);
      m.node.occ.delete(v);
      v.committed = null; v.move = null;
      const ol = m.outLane;
      if (!ol.alive) { v.dead = true; return; }
      v.lane = ol; v.s = ol.s0 + over;
      ol.vehicles.unshift(v);
      v.stopped = false; v.waitT = 0; v.nextLink = null;
      setNext(v);
      rollErr(v);
    }
  }
}

// ---------- Spurwechsel ----------
function laneGood(ln, v) {
  if (ln.kind === 'A') return false; // Einfaedelungsstreifen endet
  if (v.exitHere || !v.nextLink) return true;
  return ln.moves.some(m => m.outLink === v.nextLink);
}
function lowerBound(a, s) {
  let lo = 0, hi = a.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (a[mid].s < s) lo = mid + 1; else hi = mid; }
  return lo;
}
function leaderAcc(v, ln, v0) {
  const a = ln.vehicles;
  let i = lowerBound(a, v.s);
  while (i < a.length && a[i] === v) i++;
  const ld = a[i];
  if (!ld) return freeAcc(v, v0);
  return Math.min(freeAcc(v, v0), idmAcc(v, v0, ld.s - ld.len - v.s, ld.v));
}
function laneSafe(v, nb, urg) {
  const a = nb.vehicles;
  const i = lowerBound(a, v.s);
  const lead = a[i], foll = a[i - 1];
  if (lead) { const g = lead.s - lead.len - v.s; if (g < 1 + v.v * 0.45 * urg) return false; }
  if (foll) {
    const g = v.s - v.len - foll.s;
    if (g < 1.5 + foll.v * 0.55 * urg) return false;
    if (idmAcc(foll, laneV0(foll, nb.link), g, v.v) < -2.2 - (1 - urg) * 3) return false;
  }
  return true;
}
function tryLaneChange(v) {
  const lane = v.lane, L = lane.link;
  const al = L.allLanes;
  if (al.length < 2) return;
  const distEnd = lane.s1 - v.s;
  if (distEnd < 5 && lane.kind !== 'A') return;
  // naechste an dieser Stelle vorhandene Spur je Seite (Zusatzstreifen existieren nur abschnittsweise)
  // (in den Einfaedelungsstreifen wird nie hineingewechselt)
  const side = (d) => { for (let k = lane.slot + d; k >= 0 && k < al.length; k += d) { const ln = al[k]; if (ln.kind === 'A') continue; if (v.s >= ln.s0 + 0.5 && v.s < ln.s1 - 4) return ln; } return null; };
  const nbs = [side(-1), side(1)].filter(Boolean);
  if (!nbs.length) return;
  if (lane.kind === 'A') {
    // Einfaedeln: immer zuerst auf die Fahrbahn, je naeher am Ende desto kleinere Luecken
    const nb = side(1);
    if (nb && laneSafe(v, nb, clamp(distEnd / 160, 0.15, 1))) doLaneChange(v, nb);
    return;
  }
  if (!laneGood(lane, v)) {
    let tgt = 999;
    for (const ln of al) if (laneGood(ln, v) && Math.abs(ln.slot - lane.slot) < Math.abs(tgt - lane.slot)) tgt = ln.slot;
    if (tgt === 999) return;
    const nb = nbs.find(n => Math.abs(n.slot - tgt) < Math.abs(lane.slot - tgt));
    if (nb && laneSafe(v, nb, clamp(distEnd / 150, 0.15, 1))) doLaneChange(v, nb);
    return;
  }
  if (distEnd < 50 || lane.kind !== 'N') return;
  const v0 = laneV0(v, L);
  const accHere = leaderAcc(v, lane, v0);
  for (const nb of nbs) {
    if (nb.kind !== 'N' || !laneGood(nb, v)) continue;
    const gain = leaderAcc(v, nb, v0) - accHere;
    const right = nb.slot < lane.slot;
    if (((right && gain > -0.1 && v.v > 6) || (!right && gain > 0.6)) && laneSafe(v, nb, 1)) { doLaneChange(v, nb); return; }
  }
}
function doLaneChange(v, nb) {
  const oldLat = laneLat(v.lane, v.s) + v.lcOff;
  removeFromLane(v);
  const a = nb.vehicles;
  a.splice(lowerBound(a, v.s), 0, v);
  v.lane = nb;
  v.lcOff = clamp(oldLat - laneLat(nb, v.s), -LANE_W * 1.5, LANE_W * 1.5);
  v.lcCool = 3;
  v.nextMove = v.nextLink ? (nb.moves.find(m => m.outLink === v.nextLink) || null) : null;
}

function sortLanes() {
  for (const ln of Net.lanes) {
    const a = ln.vehicles;
    for (let i = 1; i < a.length; i++) {
      const x = a[i]; let j = i - 1;
      while (j >= 0 && a[j].s > x.s) { a[j + 1] = a[j]; j--; }
      a[j + 1] = x;
    }
  }
}

// ---------- Unfaelle ----------
function vehPose(v, out) {
  out = out || {};
  if (v.lane) lanePos(v.lane, v.s - v.len / 2, v.lcOff, out);
  else if (v.move) {
    const sc = v.s - v.len / 2;
    movePos(v.move, Math.max(0, sc), out);
    if (sc < 0) { out.x += out.hx * sc; out.y += out.hy * sc; }
  }
  return out;
}

const _pa = {}, _pb = {};
function checkCollisions() {
  for (const N of Net.nodes.values()) {
    if (N.occ.size < 2) continue;
    const arr = [];
    for (const u of N.occ) if (u.move && !u.dead) arr.push(u);
    for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) {
      const a = arr[i], b = arr[j];
      if (a.move === b.move || (a.crashed && b.crashed)) continue;
      if (!a.move.conf.get(b.move)) continue;
      vehPose(a, _pa); vehPose(b, _pb);
      let hit = false;
      for (const fa of [-0.4, 0, 0.4]) {
        const ax = _pa.x + _pa.hx * a.len * fa, ay = _pa.y + _pa.hy * a.len * fa;
        for (const fb of [-0.4, 0, 0.4]) {
          const bx = _pb.x + _pb.hx * b.len * fb, by = _pb.y + _pb.hy * b.len * fb;
          if (Math.hypot(ax - bx, ay - by) < (a.w + b.w) * 0.5) { hit = true; break; }
        }
        if (hit) break;
      }
      if (hit && (a.v + b.v) > 1.5) crash(a, b, N, null);
    }
  }
  for (const ln of Net.lanes) {
    const a = ln.vehicles;
    for (let i = 0; i < a.length - 1; i++) {
      const f = a[i], l = a[i + 1];
      if (l.s - l.len - f.s < -0.3) {
        if (f.v - l.v > 5 && !f.crashed) crash(f, l, null, ln.link.edge);
        else if (!f.crashed) { f.s = l.s - l.len - 0.2; f.v = Math.min(f.v, l.v); }
      }
    }
  }
}

function crash(a, b, N, edge) {
  if (a.crashed && b.crashed) return;
  const T = Sim.time;
  for (const u of [a, b]) if (!u.crashed) { u.crashed = T + 35 + Math.random() * 35; u.v = 0; u.acc = 0; }
  const p = vehPose(a, {});
  const rec = { x: p.x, y: p.y, t: T, node: N ? N.id : null };
  Sim.accidents.push(rec);
  if (Sim.accidents.length > 300) Sim.accidents.shift();
  Sim.stats.accidents++;
  if (N) N.accidents++; else if (edge) edge.accidents++;
  if (Sim.onAccident) Sim.onAccident(rec, N);
}

// ---------- Statistik ----------
function updateStats() {
  for (const L of Net.links) { L.vsum = 0; L.vcnt = 0; }
  let sumR = 0, n = 0, jam = 0;
  for (const v of Sim.vehicles) {
    if (v.dead || !v.lane) continue;
    const L = v.lane.link;
    L.vsum += v.v; L.vcnt++;
    // normales Anhalten/Anfahren an Kreuzungen und Einfahrten ist kein Stau
    if (v.exitHere || v.lane.s1 - v.s < 45 || v.s - v.lane.s0 < 20 || Sim.time - v.spawnT < 10) continue;
    const v0 = Math.min(L.speed, L.edge.curveV);
    sumR += Math.min(1, v.v / v0);
    if (v.v < v0 * 0.25) jam++;
    n++;
  }
  for (const L of Net.links) {
    if (L.vcnt) L.avgV += (L.vsum / L.vcnt - L.avgV) * 0.25;
    else L.avgV += (L.speed * 0.95 - L.avgV) * 0.1;
    L.flow = L.flow * 0.98 + L.flowCnt * 3600 * 0.02;
    L.flowCnt = 0;
  }
  for (const N of Net.nodes.values()) { N.thr = N.thr * 0.98 + N.thrCnt * 3600 * 0.02; N.thrCnt = 0; }
  Sim.flowIdx += ((n ? sumR / n : 1) - Sim.flowIdx) * 0.15;
  Sim.jam += ((n ? jam / n : 0) - Sim.jam) * 0.15;
}

function pushHistory() {
  const st = Sim.stats;
  Sim.history.push({ t: Sim.time, n: Sim.vehicles.length, flow: Sim.flowIdx, jam: Sim.jam, trips: st.trips - Sim.histTrips, acc: st.accidents - Sim.histAcc });
  Sim.histTrips = st.trips; Sim.histAcc = st.accidents;
  if (Sim.history.length > 240) Sim.history.shift();
}

function simRating() {
  const H = Sim.history.slice(-120);
  let trips = 0, acc = 0;
  for (const h of H) { trips += h.trips; acc += h.acc; }
  const minutes = Math.max(1, H.length * 5 / 60);
  const accRate = acc / (trips + 40) * 1000;
  const score = clamp(Sim.flowIdx * 100 - Math.min(45, accRate * 2) - Sim.jam * 25, 0, 100);
  const grade = score >= 85 ? 'A' : score >= 72 ? 'B' : score >= 58 ? 'C' : score >= 45 ? 'D' : score >= 30 ? 'E' : 'F';
  return { score, grade, accRate, tripsPerH: trips / minutes * 60, accWin: acc };
}
