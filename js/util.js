'use strict';
// ---------- Mathe- und Hilfsfunktionen ----------
const TAU = Math.PI * 2;
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const lerp = (a, b, t) => a + (b - a) * t;
const smooth01 = (t) => { t = clamp(t, 0, 1); return t * t * (3 - 2 * t); };

function angNorm(a) {
  while (a > Math.PI) a -= TAU;
  while (a < -Math.PI) a += TAU;
  return a;
}

function hashInt(x, y, s) {
  let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263) + Math.imul(s | 0, 1442695041)) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return h >>> 0;
}
const hash01 = (x, y, s) => hashInt(x, y, s) / 4294967296;

function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function vnoise(x, y, s) {
  const xi = Math.floor(x), yi = Math.floor(y);
  const xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash01(xi, yi, s), b = hash01(xi + 1, yi, s);
  const c = hash01(xi, yi + 1, s), d = hash01(xi + 1, yi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}

function fbm(x, y, s, oct) {
  let f = 0, amp = 0.5, norm = 0;
  for (let i = 0; i < oct; i++) {
    f += amp * vnoise(x, y, s + i * 101);
    norm += amp; amp *= 0.5; x *= 2.03; y *= 2.03;
  }
  return f / norm;
}

// ---------- Quadratische Bezierkurven ----------
function qPoint(p0, c, p1, t) {
  const mt = 1 - t;
  return { x: mt * mt * p0.x + 2 * mt * t * c.x + t * t * p1.x, y: mt * mt * p0.y + 2 * mt * t * c.y + t * t * p1.y };
}
function qTan(p0, c, p1, t) {
  let x = 2 * (1 - t) * (c.x - p0.x) + 2 * t * (p1.x - c.x);
  let y = 2 * (1 - t) * (c.y - p0.y) + 2 * t * (p1.y - c.y);
  const l = Math.hypot(x, y);
  if (l < 1e-9) { x = p1.x - p0.x; y = p1.y - p0.y; const l2 = Math.hypot(x, y) || 1; return { x: x / l2, y: y / l2 }; }
  return { x: x / l, y: y / l };
}
function qSplit(p0, c, p1, t) {
  const a = { x: lerp(p0.x, c.x, t), y: lerp(p0.y, c.y, t) };
  const b = { x: lerp(c.x, p1.x, t), y: lerp(c.y, p1.y, t) };
  const m = { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
  return [[p0, a, m], [m, b, p1]];
}

function segIntersect(ax, ay, bx, by, cx, cy, dx, dy) {
  const rx = bx - ax, ry = by - ay, sx = dx - cx, sy = dy - cy;
  const den = rx * sy - ry * sx;
  if (Math.abs(den) < 1e-9) return null;
  const t = ((cx - ax) * sy - (cy - ay) * sx) / den;
  const u = ((cx - ax) * ry - (cy - ay) * rx) / den;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u };
}

function distPointSeg(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  let t = l2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / l2 : 0;
  t = clamp(t, 0, 1);
  const qx = ax + dx * t, qy = ay + dy * t;
  return { d: Math.hypot(px - qx, py - qy), t };
}

// ---------- Min-Heap fuer Dijkstra ----------
class MinHeap {
  constructor() { this.k = []; this.v = []; }
  get size() { return this.k.length; }
  push(key, val) {
    const k = this.k, v = this.v;
    let i = k.length; k.push(key); v.push(val);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (k[p] <= key) break;
      k[i] = k[p]; v[i] = v[p]; i = p;
    }
    k[i] = key; v[i] = val;
  }
  pop() {
    const k = this.k, v = this.v;
    const topK = k[0], topV = v[0];
    const lk = k.pop(), lv = v.pop();
    const n = k.length;
    if (n > 0) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1;
        let m = i, mk = lk;
        if (l < n && k[l] < mk) { m = l; mk = k[l]; }
        if (r < n && k[r] < mk) { m = r; mk = k[r]; }
        if (m === i) break;
        k[i] = k[m]; v[i] = v[m]; i = m;
      }
      k[i] = lk; v[i] = lv;
    }
    this.topKey = topK;
    return topV;
  }
}
