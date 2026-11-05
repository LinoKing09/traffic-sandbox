'use strict';
// ---------- Prozedurale, unendliche Landschaft ----------
const CHUNK_LODS = [
  { size: 128, res: 256 },
  { size: 256, res: 128 },
  { size: 1024, res: 128 },
  { size: 4096, res: 128 },
];
const TOWN_CELL = 1500;

const NAME_A = ['Lin', 'Ros', 'Wil', 'Hag', 'Mar', 'Ebers', 'Kirch', 'Stein', 'Bir', 'Hohen', 'Wein', 'Fal', 'Grün', 'Lauf',
  'Mühl', 'Sonn', 'Eich', 'Tann', 'Kron', 'Fels', 'Wolf', 'Ham', 'Lich', 'Brunn', 'Asch', 'Hirsch', 'Rot', 'Weiß', 'Gold', 'Lerch',
  'Kalt', 'Mittel', 'Bern', 'Dorn', 'Erl', 'Fried', 'Wald', 'Sand', 'Linden', 'Buch'];
const NAME_B = ['berg', 'bach', 'dorf', 'feld', 'hausen', 'heim', 'ingen', 'stadt', 'burg', 'au', 'furt', 'hof', 'rode', 'wald',
  'brück', 'see', 'tal', 'kirchen', 'stetten', 'weiler', 'born', 'eck'];
const NAME_P = ['', '', '', '', '', '', 'Ober', 'Unter', 'Neu', 'Alt', 'Groß', 'Klein', 'Bad '];

const Terrain = {
  seed: 1,
  chunks: new Map(),
  towns: new Map(),
  queue: [],

  init(seed) {
    this.seed = seed >>> 0;
    this.chunks.clear();
    this.towns.clear();
  },

  elev(x, y) {
    const s = this.seed;
    let e = fbm(x / 2600, y / 2600, s, 4);
    e = (e - 0.5) * 1.75 + 0.52;
    e += (fbm(x / 420, y / 420, s + 11, 3) - 0.5) * 0.2;
    return e;
  },
  riverVal(x, y) {
    const s = this.seed;
    const wx = x + (vnoise(x / 1100, y / 1100, s + 3) - 0.5) * 700;
    const wy = y + (vnoise(x / 1100, y / 1100, s + 4) - 0.5) * 700;
    return Math.abs(fbm(wx / 3200, wy / 3200, s + 77, 3) - 0.5);
  },
  riverW(x, y) { return 0.0045 + 0.004 * vnoise(x / 2000, y / 2000, this.seed + 8); },
  forestVal(x, y) { return fbm(x / 520, y / 520, this.seed + 33, 4); },

  // Klassifikation: 0 Wasser(See) 1 Fluss 2 Sand 3 Wiese 4 Wald 5 Huegel 6 Fels 7 Schnee
  classify(e, r, rw, f) {
    if (e < 0.25) return 0;
    if (r < rw && e < 0.76) return 1;
    if (e < 0.27 || (r < rw * 1.5 && e < 0.76)) return 2;
    if (e > 0.96) return 7;
    if (e > 0.82) return 6;
    if (f > 0.58 && e < 0.74) return 4;
    if (e > 0.7) return 5;
    return 3;
  },
  info(x, y) {
    const e = this.elev(x, y);
    const r = this.riverVal(x, y);
    const rw = this.riverW(x, y);
    const type = this.classify(e, r, rw, 0);
    return { e, r, type, water: type <= 1, rock: type >= 6 };
  },

  // ---------- Chunk-Rendering ----------
  getChunk(lod, cx, cy, allowGen) {
    const key = lod + ':' + cx + ':' + cy;
    let c = this.chunks.get(key);
    if (c) { c.used = performance.now(); return c; }
    if (!allowGen) return null;
    c = this.genChunk(lod, cx, cy);
    this.chunks.set(key, c);
    if (this.chunks.size > 320) this.evict();
    return c;
  },
  evict() {
    const arr = [...this.chunks.entries()].sort((a, b) => a[1].used - b[1].used);
    for (let i = 0; i < 90; i++) this.chunks.delete(arr[i][0]);
  },
  genChunk(lod, cx, cy) {
    const { size, res } = CHUNK_LODS[lod];
    const px = size / res;
    const x0 = cx * size, y0 = cy * size;
    const s = this.seed;
    // grobes Raster fuer Hoehe/Fluss/Wald, dazwischen interpoliert
    const g = lod <= 1 ? 4 : 2, gn = res / g + 3, gs = px * g;
    const GE = new Float32Array(gn * gn), GR = new Float32Array(gn * gn), GW = new Float32Array(gn * gn), GF = new Float32Array(gn * gn);
    for (let j = 0; j < gn; j++) for (let i = 0; i < gn; i++) {
      const x = x0 + (i - 1) * gs, y = y0 + (j - 1) * gs, k = j * gn + i;
      const e = this.elev(x, y);
      GE[k] = e; GR[k] = this.riverVal(x, y); GW[k] = this.riverW(x, y);
      GF[k] = (e > 0.28 && e < 0.78) ? this.forestVal(x, y) : 0;
    }
    const smp = (A, x, y) => {
      const fx = (x - x0) / gs + 1, fy = (y - y0) / gs + 1;
      const i = clamp(Math.floor(fx), 0, gn - 2), j = clamp(Math.floor(fy), 0, gn - 2);
      const u = fx - i, v = fy - j, k = j * gn + i;
      return (A[k] * (1 - u) + A[k + 1] * u) * (1 - v) + (A[k + gn] * (1 - u) + A[k + gn + 1] * u) * v;
    };
    const classAt = (x, y) => this.classify(smp(GE, x, y), smp(GR, x, y), smp(GW, x, y), smp(GF, x, y));
    const cv = document.createElement('canvas');
    cv.width = res; cv.height = res;
    const ctx = cv.getContext('2d');
    const img = ctx.createImageData(res, res);
    const d = img.data;
    const shadeK = [40, 14, 4, 1.2][lod];
    const fine = lod <= 1;
    for (let j = 0; j < res; j++) for (let i = 0; i < res; i++) {
      const x = x0 + (i + 0.5) * px, y = y0 + (j + 0.5) * px;
      const e = smp(GE, x, y);
      const shade = (e - smp(GE, x - gs, y - gs)) * shadeK / g;
      const t = this.classify(e, smp(GR, x, y), smp(GW, x, y), smp(GF, x, y));
      // weiches Detailrauschen statt Pixelrauschen
      let dn = vnoise(x / 9, y / 9, s + 50) - 0.5;
      if (fine) dn = dn * 0.65 + (vnoise(x / 2.6, y / 2.6, s + 51) - 0.5) * 0.35;
      let R, G, B;
      switch (t) {
        case 0: { const k = clamp((0.25 - e) * 4, 0, 1); R = lerp(72, 34, k); G = lerp(132, 84, k); B = lerp(186, 150, k); R += dn * 6; G += dn * 8; B += dn * 8; break; }
        case 1: R = 66 + dn * 6; G = 128 + dn * 8; B = 186 + dn * 8; break;
        case 2: R = 214 + dn * 14; G = 202 + dn * 14; B = 150 + dn * 10; break;
        case 3: { const k = clamp((e - 0.3) / 0.36, 0, 1); R = lerp(116, 132, k) + dn * 16; G = lerp(166, 160, k) + dn * 20; B = lerp(80, 88, k) + dn * 8; break; }
        case 4: R = 58 + dn * 12; G = 100 + dn * 16; B = 54 + dn * 8; break;
        case 5: R = 126 + dn * 14; G = 138 + dn * 16; B = 92 + dn * 8; break;
        case 6: R = 140 + dn * 22; G = 134 + dn * 22; B = 126 + dn * 22; break;
        default: R = 236 + dn * 8; G = 240 + dn * 8; B = 246 + dn * 6;
      }
      if (t >= 2) { const k = 1 + clamp(shade, -0.3, 0.3); R *= k; G *= k; B *= k; }
      const o = (j * res + i) * 4;
      d[o] = R; d[o + 1] = G; d[o + 2] = B; d[o + 3] = 255;
    }
    ctx.putImageData(img, 0, 0);
    // Baeume (nur nahe Zoomstufen)
    if (fine) {
      const cell = lod === 0 ? 4.5 : 6;
      const c0x = Math.floor(x0 / cell) - 1, c1x = Math.floor((x0 + size) / cell) + 1;
      const c0y = Math.floor(y0 / cell) - 1, c1y = Math.floor((y0 + size) / cell) + 1;
      const k = 1 / px;
      const tws = this.townsInRect(x0 - 300, y0 - 300, x0 + size + 300, y0 + size + 300).map(t => [t.x, t.y, (this.townRadius(t) * 0.9) ** 2]);
      for (let cyy = c0y; cyy <= c1y; cyy++) for (let cxx = c0x; cxx <= c1x; cxx++) {
        const h = hash01(cxx, cyy, s + 99);
        if (h > 0.9) continue;
        const tx = (cxx + hash01(cxx, cyy, s + 101)) * cell, ty = (cyy + hash01(cxx, cyy, s + 102)) * cell;
        if (tws.some(([X, Y, R2]) => (tx - X) ** 2 + (ty - Y) ** 2 < R2)) continue;
        const t = classAt(tx, ty);
        const dens = t === 4 ? 0.9 : t === 5 ? 0.07 : t === 3 ? 0.025 : 0;
        if (h >= dens) continue;
        const r = (t === 4 ? 2.2 : 2.6) + hash01(cxx, cyy, s + 103) * 1.6;
        const X = (tx - x0) * k, Y = (ty - y0) * k, Rk = r * k;
        const tone = hash01(cxx, cyy, s + 104);
        ctx.fillStyle = 'rgba(0,0,0,0.25)';
        ctx.beginPath(); ctx.arc(X + Rk * 0.35, Y + Rk * 0.45, Rk, 0, TAU); ctx.fill();
        ctx.fillStyle = `rgb(${38 + tone * 30 | 0},${78 + tone * 36 | 0},${36 + tone * 18 | 0})`;
        ctx.beginPath(); ctx.arc(X, Y, Rk, 0, TAU); ctx.fill();
        if (lod === 0) {
          ctx.fillStyle = 'rgba(150,200,110,0.22)';
          ctx.beginPath(); ctx.arc(X - Rk * 0.3, Y - Rk * 0.3, Rk * 0.55, 0, TAU); ctx.fill();
        }
      }
    }
    return { cv, used: performance.now(), x0, y0, size };
  },

  // ---------- Orte ----------
  townAt(cx, cy) {
    const key = cx + ':' + cy;
    if (this.towns.has(key)) return this.towns.get(key);
    let town = null;
    const s = this.seed;
    if (hash01(cx, cy, s + 5) < 0.62) {
      const r = rng(hashInt(cx, cy, s + 9));
      for (let k = 0; k < 6; k++) {
        const x = (cx + 0.15 + 0.7 * r()) * TOWN_CELL, y = (cy + 0.15 + 0.7 * r()) * TOWN_CELL;
        const inf = this.info(x, y);
        if (inf.type >= 2 && inf.type <= 5 && inf.r > 0.02) {
          let pop = Math.round(350 * Math.exp(r() * 3.3));
          if (r() < 0.07) pop *= 3;
          pop = Math.round(pop / 50) * 50;
          const pre = NAME_P[Math.floor(r() * NAME_P.length)];
          let root = NAME_A[Math.floor(r() * NAME_A.length)] + NAME_B[Math.floor(r() * NAME_B.length)];
          if (pre && !pre.endsWith(' ')) root = root.charAt(0).toLowerCase() + root.slice(1);
          const name = pre + root;
          town = { id: key, x, y, pop, name: name.charAt(0).toUpperCase() + name.slice(1), houses: null, nAtt: 0 };
          break;
        }
      }
    }
    this.towns.set(key, town);
    return town;
  },
  townsInRect(x0, y0, x1, y1) {
    const out = [];
    const c0 = Math.floor(x0 / TOWN_CELL), c1 = Math.floor(x1 / TOWN_CELL);
    const r0 = Math.floor(y0 / TOWN_CELL), r1 = Math.floor(y1 / TOWN_CELL);
    for (let cy = r0; cy <= r1; cy++) for (let cx = c0; cx <= c1; cx++) {
      const t = this.townAt(cx, cy);
      if (t) out.push(t);
    }
    return out;
  },
  townRadius(t) { return 45 + Math.sqrt(t.pop) * 0.9; },
  townHouses(t) {
    if (t.houses) return t.houses;
    const r = rng(hashInt(Math.round(t.x), Math.round(t.y), this.seed + 21));
    const n = Math.round(clamp(t.pop / 55, 12, 320));
    const R = this.townRadius(t);
    const hs = [];
    for (let i = 0; i < n * 3 && hs.length < n; i++) {
      const a = r() * TAU, d = Math.pow(r(), 0.75) * R;
      const x = t.x + Math.cos(a) * d, y = t.y + Math.sin(a) * d;
      if (Math.hypot(x - t.x, y - t.y) < 14) continue;
      if (hs.some(o => Math.abs(o.x - x) < 17 && Math.abs(o.y - y) < 17)) continue;
      const inf = this.info(x, y);
      if (inf.water || inf.rock) continue;
      const big = d < R * 0.35 && t.pop > 2500 && r() < 0.5;
      const w = big ? 12 + r() * 14 : 7 + r() * 6, h = big ? 10 + r() * 12 : 6 + r() * 5;
      const roof = big ? ['#8a8f96', '#9aa0a6', '#7b8794'][Math.floor(r() * 3)] : ['#b5543c', '#a3473a', '#8f5a44', '#c06a4a', '#7d6a5d', '#9a9a9a'][Math.floor(r() * 6)];
      hs.push({ x, y, w, h, a: r() * Math.PI, roof, kind: big ? 'shop' : 'home', weight: big ? 6 : 1, town: t, att: null, gone: false });
    }
    t.houses = hs;
    t.nAtt = 0;
    if (typeof attachTown === 'function' && Net.edges.size) { attachTown(t); if (typeof Sim !== 'undefined') Sim.housesDirty = true; }
    return hs;
  },
};
