'use strict';
// ---------- Verkehrssimulation ----------
const MAX_VEH = 2600;
const CAR_COLORS = ['#ececec', '#2b2b2b', '#c0392b', '#2c6fbb', '#7f8c8d', '#e5c33b', '#2e8b57', '#7d4ba0', '#d35400',
  '#b8c2cc', '#1a3d6b', '#7a1f1f', '#4f6d7a', '#f0f0e8'];
const TRUCK_COLORS = ['#d8d2c4', '#5d6d7e', '#a04000', '#1e8449', '#e8e2d0'];

const Sim = {
  vehicles: [], time: 0, tick: 0, nextVid: 1, demand: 1, errMul: 1, speed: 1, paused: false,
  routes: new Map(), nextRoute: 0, townNodes: [], lightNodes: [],
  stats: { trips: 0, accidents: 0, lost: 0, gaveUp: 0, rejected: 0, towed: 0, tripTime: 0 },
  accidents: [], history: [], lastHist: 0, lastStat: 0,
  flowIdx: 1, jam: 0, histTrips: 0, histAcc: 0, onAccident: null,

  reset() {
    this.vehicles = []; this.time = 0; this.tick = 0; this.routes = new Map();
    this.stats = { trips: 0, accidents: 0, lost: 0, gaveUp: 0, rejected: 0, towed: 0, tripTime: 0 };
    this.accidents = []; this.history = []; this.lastHist = 0; this.lastStat = 0; this.flowIdx = 1; this.jam = 0;
    this.histTrips = 0; this.histAcc = 0;
  },

  onNetChanged(nodes) {
    for (const N of nodes) if (!N.deleted) N.occ = new Set();
    this.lightNodes = [...Net.nodes.values()].filter(N => N.ctl === 'light' && N.phases.length);
    computeRoutes();
    for (const v of this.vehicles) {
      if (v.dead) continue;
      if (v.kill) { removeVehicle(v); continue; }
      if (v.move) {
        if (v.move.node.deleted) { removeVehicle(v); continue; }
        if (nodes.has(v.move.node)) v.move.node.occ.add(v);
      } else if (v.lane) {
        if (!v.lane.alive) { removeVehicle(v); continue; }
        if (nodes.has(v.lane.link.to) || (v.committed && v.committed.node.deleted)) {
          if (v.committed) v.committed.node.occ.delete(v);
          v.committed = null;
          setNext(v);
        } else if (v.nextMove && !v.lane.moves.includes(v.nextMove)) setNext(v);
      }
    }
    this.vehicles = this.vehicles.filter(v => !v.dead);
  },

  step(dt) {
    this.time += dt; this.tick++;
    updateLights(dt);
    if (this.time >= this.nextRoute) computeRoutes();
    spawnStep(dt);
    sortLanes();
    for (const v of this.vehicles) if (!v.dead && v.lane && !v.crashed && !v.committed && v.lcCool <= 0 && ((v.id + this.tick) % 4) === 0) tryLaneChange(v);
    for (const ln of Net.lanes) { const a = ln.vehicles; for (let i = 0; i < a.length; i++) a[i].idx = i; }
    for (const v of this.vehicles) if (!v.dead) computeAccel(v);
    for (const v of this.vehicles) if (!v.dead) integrate(v, dt);
    checkCollisions();
    for (const v of this.vehicles) {
      if (v.dead) continue;
      if (v.crashed && this.time > v.crashed) { removeVehicle(v); this.stats.towed++; }
      else if (!v.crashed && v.waitT > 200) { removeVehicle(v); this.stats.gaveUp++; }
    }
    if (this.tick % 30 === 0) this.vehicles = this.vehicles.filter(v => !v.dead);
    if (this.time - this.lastStat >= 1) { this.lastStat = this.time; updateStats(); }
    if (this.time - this.lastHist >= 5) { this.lastHist = this.time; pushHistory(); }
  },
};

function newVehicle(lane, dest, origin) {
  const r = Math.random;
  const truck = r() < 0.1;
  return {
    id: Sim.nextVid++, lane, move: null, s: lane.s0, v: 0, acc: 0, dest, origin, truck,
    len: truck ? 12 : 4.3 + r() * 0.7, w: truck ? 2.5 : 1.85,
    drv: truck ? { a: 1.0, b: 2.4, T: 1.4 + r() * 0.4, s0: 2.2, vf: 0.82 + r() * 0.08, gap: 1.2, vmax: 25 }
      : { a: 1.9 + r() * 0.8, b: 2.8, T: 0.8 + r() * 0.6, s0: 1.6, vf: 0.92 + r() * 0.2, gap: 0.75 + r() * 0.5, vmax: 50 },
    color: truck ? TRUCK_COLORS[Math.floor(r() * TRUCK_COLORS.length)] : CAR_COLORS[Math.floor(r() * CAR_COLORS.length)],
    nextLink: null, nextMove: null, exitHere: false, committed: null, stopped: false, stopT: 0, waitT: 0,
    err: false, lcOff: 0, lcCool: 1 + r() * 2, crashed: 0, spawnT: Sim.time, dist: 0, lost: false,
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
  if (v.dest && v.dest.town) v.dest.town.arrived++;
  removeVehicle(v);
}

// ---------- Routing ----------
function computeRoutes() {
  Sim.nextRoute = Sim.time + 3;
  const links = Net.links, nL = links.length;
  const towns = [];
  for (const N of Net.nodes.values()) if (N.town && N.edges.length) towns.push(N);
  Sim.townNodes = towns;
  const travel = new Float64Array(nL);
  for (const L of links) travel[L.id] = (Math.max(L.len, 1) + 6) / Math.max(1.2, Math.min(L.avgV, L.speed));
  const routes = new Map();
  for (const D of towns) {
    if (!D.inLinks.length) continue;
    const cost = new Float64Array(nL).fill(Infinity);
    const h = new MinHeap();
    for (const L of D.inLinks) { cost[L.id] = travel[L.id]; h.push(cost[L.id], L); }
    while (h.size) {
      const L = h.pop(), c = h.topKey;
      if (c > cost[L.id]) continue;
      const N = L.from;
      const preds = N.trans.get(L);
      if (!preds) continue;
      for (const P of preds) {
        const nc = c + travel[P.id] + (N.pen.get(P) || 0);
        if (nc < cost[P.id]) { cost[P.id] = nc; h.push(nc, P); }
      }
    }
    routes.set(D.id, cost);
  }
  Sim.routes = routes;
  for (const O of towns) {
    const t = O.town;
    t.dests = []; t.sumW = 0;
    for (const D of towns) {
      if (D === O) continue;
      const cost = routes.get(D.id);
      if (!cost) continue;
      let best = Infinity;
      for (const L of O.outLinks) best = Math.min(best, cost[L.id]);
      if (best < Infinity) {
        const d = Math.hypot(D.x - O.x, D.y - O.y);
        const w = D.town.pop / (1 + d / 4000);
        t.dests.push({ D, w }); t.sumW += w;
      }
    }
  }
}

function chooseNext(v, L) {
  const outs = L.to.transOut.get(L);
  if (!outs || !outs.length) return null;
  const cost = v.dest ? Sim.routes.get(v.dest.id) : null;
  let best = null, bc = Infinity;
  if (cost) for (const o of outs) {
    const c = cost[o.id];
    if (c < Infinity) { const cc = c * (1 + 0.06 * Math.random()); if (cc < bc) { bc = cc; best = o; } }
  }
  if (!best) { v.lost = true; best = outs[Math.floor(Math.random() * outs.length)]; }
  return best;
}

function setNext(v) {
  const lane = v.lane, L = lane.link, N = L.to;
  v.exitHere = false;
  if (N.town && (N === v.dest || v.lost)) { v.exitHere = true; v.nextLink = null; v.nextMove = null; return; }
  const outs = N.transOut.get(L) || [];
  if (!v.nextLink || v.nextLink.dead || !outs.includes(v.nextLink)) v.nextLink = chooseNext(v, L);
  v.nextMove = v.nextLink ? (lane.moves.find(m => m.outLink === v.nextLink) || null) : null;
}

function rollErr(v) {
  const L = v.lane.link, N = L.to;
  const r = N.rank.get(L) || 0;
  let p = 0;
  if (N.edges.length >= 3 || N.ring) {
    if (N.ctl === 'light' || N.ctl === 'allstop') p = 0.0015;
    else if (N.ring) p = r ? 0 : 0.003;
    else if (!r) {
      const majV = N.major ? Math.max(N.major[0].kmh, N.major[1].kmh) : 50;
      p = (N.ctl === 'stop' ? 0.004 : 0.011) * majV / 50;
    } else p = 0.002;
  }
  v.err = Math.random() < p * Sim.errMul;
}

// ---------- Erzeugung ----------
function pickDest(t) {
  let r = Math.random() * t.sumW;
  for (const d of t.dests) { r -= d.w; if (r <= 0) return d.D; }
  return t.dests[t.dests.length - 1].D;
}

function spawnStep(dt) {
  for (const O of Sim.townNodes) {
    const t = O.town;
    if (!t.dests.length || !O.outLinks.length) continue;
    const rate = Sim.demand * t.pop / 1000 * 0.02;
    if (Math.random() < rate * dt) {
      if (t.queue.length < 30) t.queue.push(pickDest(t));
      else Sim.stats.rejected++;
    }
    if (t.queue.length && Sim.vehicles.length < MAX_VEH) trySpawn(O, t);
  }
}

function trySpawn(O, t) {
  const D = t.queue[0];
  const cost = Sim.routes.get(D.id);
  if (D.deleted || !cost) { t.queue.shift(); return; }
  let L = null, bc = Infinity;
  for (const o of O.outLinks) if (cost[o.id] < bc) { bc = cost[o.id]; L = o; }
  if (!L) { t.queue.shift(); return; }
  const cands = L.lanes.filter(ln => { const f = ln.vehicles[0]; return !f || f.s - f.len > ln.s0 + 3; });
  if (!cands.length) return;
  const tmp = { dest: D, lost: false };
  const nl = L.to === D ? null : chooseNext(tmp, L);
  let pref = nl ? cands.filter(ln => ln.moves.some(m => m.outLink === nl)) : cands;
  if (!pref.length) pref = cands;
  const lane = pref[Math.floor(Math.random() * pref.length)];
  const v = newVehicle(lane, D, O);
  const f = lane.vehicles[0];
  v.v = Math.min(L.speed * 0.6, f ? f.v : 99);
  lane.vehicles.unshift(v);
  Sim.vehicles.push(v);
  v.nextLink = nl;
  setNext(v);
  rollErr(v);
  t.queue.shift(); t.sent++;
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
      // Zeitluecken-Steuerung: Gruen endet, wenn niemand mehr durchfaehrt
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
// Zeit bis Strecke D zurueckgelegt ist (Beschleunigung bis vmax, dann konstant)
function tReach(u, D, vmax) {
  if (D <= 0) return 0;
  const a = Math.max(0.6, u.drv.a), vv = u.v;
  vmax = Math.max(vmax || 99, 1);
  if (vv >= vmax - 0.3) return D / Math.max(vv, 0.1);
  const t1 = (vmax - vv) / a, d1 = (vv + vmax) / 2 * t1;
  if (d1 >= D) return (-vv + Math.sqrt(vv * vv + 2 * a * D)) / a;
  return t1 + (D - d1) / vmax;
}
function uV0(u) { return u.lane ? laneV0(u, u.lane.link) : u.move ? u.move.vmax : 15; }

function laneV0(v, L) { return Math.min(L.speed * v.drv.vf, L.edge.curveV, v.drv.vmax); }

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
    } else if (distEnd < 160) {
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
    if (distEnd < 220 && !v.exitHere) {
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
          const need = v.v * v.v / (2 * Math.max(dist - 0.5, 0.3));
          if (need < 9.5) return false;
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
  const mustStop = N.ctl === 'allstop' || (N.ctl === 'stop' && rank === 0);
  if (mustStop && !v.stopped) {
    if (dist < 4.5 && v.v < 0.6) { v.stopped = true; v.stopT = Sim.time; }
    else return false;
  }
  if (N.ctl === 'light') {
    const st = lightState(N, L);
    if (st === 'R') return false;
    if (st === 'Y') {
      // wartende Linksabbieger raeumen bei Gelb (Nachzuegler)
      if (dist < 4 && v.v < 2) {
        if (!mayEnter(v, m, dist)) return false;
        commit(v, m);
        return true;
      }
      if (dist > v.v * v.v / 7 + 1.5) return false;
      commit(v, m);
      return true;
    }
  }
  if (!mayEnter(v, m, dist)) return false;
  if (dist < v.v * v.v / 9 + 2.5) commit(v, m);
  return true;
}

function hasPrio(N, u, mu, v, m) {
  if (N.ctl === 'allstop') return u.stopped && (!v.stopped || u.stopT < v.stopT);
  if (N.ctl === 'light') {
    if (m.kind === 'U') return true;
    if (m.kind === 'L' && mu.kind !== 'L') return true;
    return false;
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

function mayEnter(v, m, dist) {
  const N = m.node;
  const ol = m.outLane, q = ol.vehicles[0];
  if (q && q.s - q.len - ol.s0 < v.len + 1 && q.v < 0.8) return false;
  for (const u of m.vehicles) if (u.s < u.len + 1 && u.v < 1) return false;
  const imp = Math.max(0.35, 1 - v.waitT / 60);
  const margin = 0.5 + 1.0 * v.drv.gap * imp;
  const vmV = Math.min(m.vmax, laneV0(v, m.outLink));
  // Fahrzeuge im Knoten oder fest eingefahren
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
      const eta = tReach(u, du + c.sOther, uV0(u));
      if (eta < tReach(v, dist + c.sSelf + v.len + 1, vmV) + margin) return false;
    }
  }
  if (v.err) return true;
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
        if (u.committed || u.crashed || u.dead) continue;
        // stehender Rueckstau hinter dem ersten Fahrzeug kann nicht sofort kommen
        if (u.v < 1.5 && i < a.length - 1 && !a[i + 1].committed) break;
        cnt++;
        const mu = u.nextMove;
        if (!mu) continue;
        const c = m.conf.get(mu);
        if (!c) continue;
        if (!hasPrio(N, u, mu, v, m)) continue;
        if (u.v < 0.5 && u.waitT > 2 && v.waitT > u.waitT + 2) continue;
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
  if (v.exitHere || !v.nextLink) return true;
  return ln.moves.some(m => m.outLink === v.nextLink);
}
function lanePosIdx(ln) { return ln.turn ? ln.link.n : ln.idx; }
function laneNeighbors(lane) {
  const L = lane.link, res = [];
  if (lane.turn) { res.push(L.lanes[L.n - 1]); return res; }
  if (lane.idx > 0) res.push(L.lanes[lane.idx - 1]);
  if (lane.idx < L.n - 1) res.push(L.lanes[lane.idx + 1]);
  if (lane.idx === L.n - 1 && L.turnLane) res.push(L.turnLane);
  return res;
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
    const fa = idmAcc(foll, laneV0(foll, nb.link), g, v.v);
    if (fa < -2.2 - (1 - urg) * 3) return false;
  }
  return true;
}
function tryLaneChange(v) {
  const lane = v.lane, L = lane.link;
  if (L.allLanes.length < 2) return;
  const distEnd = lane.s1 - v.s;
  if (distEnd < 5) return;
  const good = laneGood(lane, v);
  const nbs = laneNeighbors(lane).filter(nb => v.s >= nb.s0 + 0.5 && v.s < nb.s1 - 4);
  if (!nbs.length) return;
  if (!good) {
    const goodLanes = L.allLanes.filter(ln => laneGood(ln, v));
    if (!goodLanes.length) return;
    const p = lanePosIdx(lane);
    let tgt = 999;
    for (const ln of goodLanes) { const q = lanePosIdx(ln); if (Math.abs(q - p) < Math.abs(tgt - p)) tgt = q; }
    const nb = nbs.find(n => Math.abs(lanePosIdx(n) - tgt) < Math.abs(p - tgt));
    if (!nb) return;
    const urg = clamp(distEnd / 150, 0.15, 1);
    if (laneSafe(v, nb, urg)) doLaneChange(v, nb);
    return;
  }
  if (distEnd < 50) return;
  const v0 = laneV0(v, L);
  const accHere = leaderAcc(v, lane, v0);
  for (const nb of nbs) {
    if (nb.turn || !laneGood(nb, v)) continue;
    const gain = leaderAcc(v, nb, v0) - accHere;
    const right = nb.idx < lane.idx;
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
  if (v.lane) {
    lanePos(v.lane, v.s - v.len / 2, v.lcOff, out);
  } else if (v.move) {
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
      const g = l.s - l.len - f.s;
      if (g < -0.3) {
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
  const fi = n ? sumR / n : 1;
  Sim.flowIdx += (fi - Sim.flowIdx) * 0.15;
  Sim.jam += ((n ? jam / n : 0) - Sim.jam) * 0.15;
}

function pushHistory() {
  const st = Sim.stats;
  Sim.history.push({
    t: Sim.time, n: Sim.vehicles.length, flow: Sim.flowIdx, jam: Sim.jam,
    trips: st.trips - Sim.histTrips, acc: st.accidents - Sim.histAcc,
  });
  Sim.histTrips = st.trips; Sim.histAcc = st.accidents;
  if (Sim.history.length > 240) Sim.history.shift();
}

function simRating() {
  const H = Sim.history.slice(-120); // letzte 10 Minuten
  let trips = 0, acc = 0;
  for (const h of H) { trips += h.trips; acc += h.acc; }
  const minutes = Math.max(1, H.length * 5 / 60);
  const accRate = acc / (trips + 40) * 1000; // gegen kleine Stichproben gedaempft
  let score = Sim.flowIdx * 100 - Math.min(45, accRate * 2) - Sim.jam * 25;
  score = clamp(score, 0, 100);
  const grade = score >= 85 ? 'A' : score >= 72 ? 'B' : score >= 58 ? 'C' : score >= 45 ? 'D' : score >= 30 ? 'E' : 'F';
  return { score, grade, accRate, tripsPerH: trips / minutes * 60, accWin: acc };
}
