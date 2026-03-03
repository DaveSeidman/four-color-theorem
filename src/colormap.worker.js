// colormap.worker.js
// Port of 4colormap.py — all processing runs in this worker thread.

// Palette (RGB)
const PALETTE = [
  [60, 180, 75],
  [230, 25, 75],
  [255, 225, 25],
  [0, 130, 200],
];

// ─────────────────────────────────────────────
// IMAGE PROCESSING
// ─────────────────────────────────────────────

function toGrayscale(rgba, n) {
  const gray = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    // Fast integer approximation of 0.299R + 0.587G + 0.114B
    gray[i] = (77 * rgba[i * 4] + 150 * rgba[i * 4 + 1] + 29 * rgba[i * 4 + 2]) >> 8;
  }
  return gray;
}

function otsuThreshold(gray) {
  const hist = new Float64Array(256);
  for (const v of gray) hist[v]++;
  const n = gray.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, best = 0, thr = 128;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (!wB) continue;
    const wF = n - wB;
    if (!wF) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const v = wB * wF * (mB - mF) * (mB - mF);
    if (v > best) { best = v; thr = t; }
  }
  return thr;
}

// ─────────────────────────────────────────────
// EDGE DETECTION (for photos / webcam captures)
// ─────────────────────────────────────────────

// Separable Gaussian blur — 1D kernel generated from pascal triangle approx
function gaussianBlur(src, w, h, radius) {
  const r = Math.max(1, Math.round(radius));
  const size = 2 * r + 1;
  // Build 1D Gaussian kernel
  const sigma = r / 2.0;
  const k = new Float32Array(size);
  let sum = 0;
  for (let i = 0; i < size; i++) {
    const x = i - r;
    k[i] = Math.exp(-(x * x) / (2 * sigma * sigma));
    sum += k[i];
  }
  for (let i = 0; i < size; i++) k[i] /= sum;

  const tmp = new Float32Array(w * h);
  const dst = new Float32Array(w * h);

  // Horizontal pass
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let ki = 0; ki < size; ki++) {
        const nx = Math.max(0, Math.min(w - 1, x + ki - r));
        acc += src[y * w + nx] * k[ki];
      }
      tmp[y * w + x] = acc;
    }
  }
  // Vertical pass
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let ki = 0; ki < size; ki++) {
        const ny = Math.max(0, Math.min(h - 1, y + ki - r));
        acc += tmp[ny * w + x] * k[ki];
      }
      dst[y * w + x] = acc;
    }
  }
  return dst;
}

// Sobel gradient magnitude → Uint8 (0–255)
function sobelMagnitude(gray, w, h) {
  const mag = new Float32Array(w * h);
  let maxMag = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const tl = gray[(y-1)*w+(x-1)], tc = gray[(y-1)*w+x], tr = gray[(y-1)*w+(x+1)];
      const ml = gray[y    *w+(x-1)],                        mr = gray[y    *w+(x+1)];
      const bl = gray[(y+1)*w+(x-1)], bc = gray[(y+1)*w+x], br = gray[(y+1)*w+(x+1)];
      const gx = -tl - 2*ml - bl + tr + 2*mr + br;
      const gy = -tl - 2*tc - tr + bl + 2*bc + br;
      const m = Math.sqrt(gx*gx + gy*gy);
      mag[y*w+x] = m;
      if (m > maxMag) maxMag = m;
    }
  }
  const out = new Uint8Array(w * h);
  if (maxMag > 0) {
    for (let i = 0; i < w * h; i++) out[i] = (mag[i] / maxMag * 255) | 0;
  }
  return out;
}

// Full edge-detect pipeline: blur → Sobel → threshold
// Returns a "lineImg" (255 = edge/line, 0 = open) suitable for the rest of the pipeline
function buildEdgeLineImage(gray, w, h, blurRadius, edgeThreshold) {
  const blurred = gaussianBlur(gray, w, h, blurRadius);
  const mag = sobelMagnitude(blurred, w, h);
  const lineImg = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) {
    lineImg[i] = mag[i] >= edgeThreshold ? 255 : 0;
  }
  return { lineImg, mag };
}

// ─────────────────────────────────────────────
// MORPHOLOGY
// ─────────────────────────────────────────────

// Ellipse-shaped structuring element (like cv2 MORPH_ELLIPSE)
function makeEllipseOffsets(size) {
  const r = (size - 1) / 2;
  const offsets = [];
  for (let dy = -Math.floor(r); dy <= Math.ceil(r); dy++) {
    for (let dx = -Math.floor(r); dx <= Math.ceil(r); dx++) {
      if (dy * dy + dx * dx <= (r + 0.5) * (r + 0.5)) {
        offsets.push(dy, dx);
      }
    }
  }
  return offsets;
}

function dilate(src, w, h, k) {
  const dst = new Uint8Array(src.length);
  const klen = k.length;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let max = 0;
      for (let i = 0; i < klen; i += 2) {
        const ny = y + k[i], nx = x + k[i + 1];
        if (ny >= 0 && ny < h && nx >= 0 && nx < w) {
          const v = src[ny * w + nx];
          if (v > max) { max = v; if (max === 255) break; }
        }
      }
      dst[y * w + x] = max;
    }
  }
  return dst;
}

function erode(src, w, h, k) {
  const dst = new Uint8Array(src.length);
  const klen = k.length;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let min = 255;
      for (let i = 0; i < klen; i += 2) {
        const ny = y + k[i], nx = x + k[i + 1];
        // Out-of-bounds = 0 (matches cv2 BORDER_CONSTANT default)
        const v = (ny >= 0 && ny < h && nx >= 0 && nx < w) ? src[ny * w + nx] : 0;
        if (v < min) { min = v; if (!min) break; }
      }
      dst[y * w + x] = min;
    }
  }
  return dst;
}

// MORPH_CLOSE = dilate then erode
function morphClose(src, w, h, ksize, iters) {
  const k = makeEllipseOffsets(ksize);
  let r = new Uint8Array(src);
  for (let i = 0; i < iters; i++) {
    r = erode(dilate(r, w, h, k), w, h, k);
  }
  return r;
}

// Flood-fill from corner (0,0) to remove background, returning only enclosed regions
function floodFillBackground(openSpace, w, h) {
  const n = w * h;
  const filled = new Uint8Array(openSpace);
  if (!filled[0]) return filled; // corner is already barrier
  const q = new Uint32Array(n);
  let head = 0, tail = 0;
  filled[0] = 0;
  q[tail++] = 0;
  while (head < tail) {
    const p = q[head++];
    const py = (p / w) | 0, px = p % w;
    if (py > 0)   { const nb = p - w; if (filled[nb] === 255) { filled[nb] = 0; q[tail++] = nb; } }
    if (py < h-1) { const nb = p + w; if (filled[nb] === 255) { filled[nb] = 0; q[tail++] = nb; } }
    if (px > 0)   { const nb = p - 1; if (filled[nb] === 255) { filled[nb] = 0; q[tail++] = nb; } }
    if (px < w-1) { const nb = p + 1; if (filled[nb] === 255) { filled[nb] = 0; q[tail++] = nb; } }
  }
  return filled; // remaining 255 = enclosed regions
}

// 4-connected BFS connected components with area/centroid stats
function labelRegions(mask, w, h, minArea) {
  const n = w * h;
  const labels = new Int32Array(n);
  const q = new Uint32Array(n);
  let nextLabel = 1;
  const stats = []; // {area, cx, cy}

  for (let i = 0; i < n; i++) {
    if (mask[i] !== 255 || labels[i]) continue;
    const lid = nextLabel++;
    let head = 0, tail = 0;
    q[tail++] = i;
    labels[i] = lid;
    let area = 0, sumX = 0, sumY = 0;
    while (head < tail) {
      const p = q[head++];
      area++;
      const py = (p / w) | 0, px = p % w;
      sumX += px; sumY += py;
      if (py > 0)   { const nb = p - w; if (mask[nb] === 255 && !labels[nb]) { labels[nb] = lid; q[tail++] = nb; } }
      if (py < h-1) { const nb = p + w; if (mask[nb] === 255 && !labels[nb]) { labels[nb] = lid; q[tail++] = nb; } }
      if (px > 0)   { const nb = p - 1; if (mask[nb] === 255 && !labels[nb]) { labels[nb] = lid; q[tail++] = nb; } }
      if (px < w-1) { const nb = p + 1; if (mask[nb] === 255 && !labels[nb]) { labels[nb] = lid; q[tail++] = nb; } }
    }
    stats.push({ area, cx: sumX / area, cy: sumY / area });
  }

  // Filter small regions and remap to compact 1..M
  const remap = new Int32Array(nextLabel);
  let newId = 0;
  for (let i = 1; i < nextLabel; i++) {
    if (stats[i - 1].area >= minArea) remap[i] = ++newId;
  }

  const newLabels = new Int32Array(n);
  for (let i = 0; i < n; i++) {
    if (labels[i]) newLabels[i] = remap[labels[i]];
  }

  const centroids = new Float32Array((newId + 1) * 2);
  for (let i = 1; i < nextLabel; i++) {
    const j = remap[i];
    if (j) { centroids[j * 2] = stats[i - 1].cx; centroids[j * 2 + 1] = stats[i - 1].cy; }
  }

  return { labels: newLabels, nRegions: newId, centroids };
}

// Estimate line thickness by sampling horizontal runs
function estimateAutoProbe(sealedLine, w, h) {
  let total = 0, count = 0;
  const step = Math.max(1, (h / 100) | 0);
  for (let y = 0; y < h; y += step) {
    let run = 0;
    for (let x = 0; x < w; x++) {
      if (sealedLine[y * w + x] === 255) {
        run++;
      } else if (run) {
        total += run; count++; run = 0;
      }
    }
    if (run) { total += run; count++; }
  }
  const avg = count > 0 ? total / count : 4;
  return Math.max(2, Math.min(96, Math.round(avg * 0.95 + 2)));
}

// Thick-line-safe adjacency detection via probe rays across line pixels
// For each line pixel, probe outward in 4 axis/diagonal pairs.
// If opposite probes land in different regions, it's an adjacency edge.
function buildAdjacency(labels, sealedLine, w, h, nRegions, maxProbe, minBorderPixels) {
  // Collect line pixel coordinates
  const linesY = [];
  const linesX = [];
  const n = w * h;
  for (let i = 0; i < n; i++) {
    if (sealedLine[i] === 255) {
      linesY.push((i / w) | 0);
      linesX.push(i % w);
    }
  }

  const stride = nRegions + 2;
  const pairMap = new Map(); // key → {lo, hi, count, sumX, sumY}

  // Direction pairs: [dy1, dx1, dy2, dx2]
  const DIRS = [
    [0, -1, 0, 1],    // W–E
    [-1, 0, 1, 0],    // N–S
    [-1, -1, 1, 1],   // NW–SE
    [-1, 1, 1, -1],   // NE–SW
  ];

  for (let i = 0; i < linesY.length; i++) {
    const py = linesY[i], px = linesX[i];
    for (let d = 1; d <= maxProbe; d++) {
      for (const [dy1, dx1, dy2, dx2] of DIRS) {
        const ay = py + dy1 * d, ax = px + dx1 * d;
        const by = py + dy2 * d, bx = px + dx2 * d;
        if (ay < 0 || ay >= h || ax < 0 || ax >= w) continue;
        if (by < 0 || by >= h || bx < 0 || bx >= w) continue;
        const a = labels[ay * w + ax];
        const b = labels[by * w + bx];
        if (!a || !b || a === b) continue;
        const lo = a < b ? a : b;
        const hi = a < b ? b : a;
        const key = lo * stride + hi;
        let e = pairMap.get(key);
        if (!e) { e = { lo, hi, count: 0, sumX: 0, sumY: 0 }; pairMap.set(key, e); }
        e.count++;
        e.sumX += px;
        e.sumY += py;
      }
    }
  }

  const adj = Array.from({ length: nRegions + 1 }, () => new Set());
  const edgePos = {};

  for (const e of pairMap.values()) {
    if (e.count >= minBorderPixels && e.lo <= nRegions && e.hi <= nRegions) {
      adj[e.lo].add(e.hi);
      adj[e.hi].add(e.lo);
      edgePos[`${e.lo},${e.hi}`] = [e.sumX / e.count, e.sumY / e.count];
    }
  }

  return { adj, edgePos };
}

// ─────────────────────────────────────────────
// DSATUR + BACKTRACKING 4-COLORING
// ─────────────────────────────────────────────

function fourColor(adj, nRegions) {
  const color = new Array(nRegions + 1).fill(-1);
  const sat = Array.from({ length: nRegions + 1 }, () => new Set());

  function pickNode() {
    let best = -1, bSat = -1, bDeg = -1;
    for (let u = 1; u <= nRegions; u++) {
      if (color[u] !== -1) continue;
      const s = sat[u].size, d = adj[u].size;
      if (s > bSat || (s === bSat && d > bDeg)) {
        best = u; bSat = s; bDeg = d;
      }
    }
    return best;
  }

  function dfs() {
    const u = pickNode();
    if (u === -1) return true;
    for (let c = 0; c < 4; c++) {
      let ok = true;
      for (const v of adj[u]) {
        if (color[v] === c) { ok = false; break; }
      }
      if (!ok) continue;
      color[u] = c;
      const changed = [];
      for (const v of adj[u]) {
        if (color[v] === -1 && !sat[v].has(c)) { sat[v].add(c); changed.push(v); }
      }
      if (dfs()) return true;
      color[u] = -1;
      for (const v of changed) {
        let hasC = false;
        for (const w of adj[v]) { if (color[w] === c) { hasC = true; break; } }
        if (!hasC) sat[v].delete(c);
      }
    }
    return false;
  }

  if (!dfs()) throw new Error('4-coloring failed — region graph may be malformed.');
  return color;
}

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────

function grayToRGBA(arr, n) {
  const out = new Uint8ClampedArray(n * 4);
  for (let i = 0; i < n; i++) {
    const v = arr[i];
    out[i * 4] = v; out[i * 4 + 1] = v; out[i * 4 + 2] = v; out[i * 4 + 3] = 255;
  }
  return out;
}

// Random color per label for the "labeled regions" debug view
function labelsToRGBA(labels, nRegions, w, h) {
  const n = w * h;
  const out = new Uint8ClampedArray(n * 4);
  // Build deterministic random palette for each region
  const pal = new Uint8Array((nRegions + 1) * 3);
  pal.fill(255); // background = white
  const rng = (seed) => {
    let x = seed * 2654435761 >>> 0;
    x = (x ^ (x >> 16)) >>> 0;
    return x & 0xff;
  };
  for (let i = 1; i <= nRegions; i++) {
    pal[i * 3]     = rng(i * 3);
    pal[i * 3 + 1] = rng(i * 3 + 1);
    pal[i * 3 + 2] = rng(i * 3 + 2);
  }
  for (let i = 0; i < n; i++) {
    const rid = labels[i];
    out[i * 4]     = pal[rid * 3];
    out[i * 4 + 1] = pal[rid * 3 + 1];
    out[i * 4 + 2] = pal[rid * 3 + 2];
    out[i * 4 + 3] = 255;
  }
  return out;
}

// ─────────────────────────────────────────────
// MAIN ENTRY
// ─────────────────────────────────────────────

self.onmessage = ({ data }) => {
  const { imageData, params } = data;
  const { width: w, height: h, data: rgba } = imageData;
  const n = w * h;

  try {
    // ── 1. Grayscale → line image ──────────────────
    const gray = toGrayscale(rgba, n);

    let lineImg, binary, thr = null, edgeMag = null;

    if (params.preprocessMode === 'edge') {
      self.postMessage({ type: 'progress', step: 'Detecting edges (Gaussian + Sobel)…', pct: 5 });
      const blurRadius = params.blurRadius ?? 2;
      const edgeThreshold = params.edgeThreshold ?? 30;
      const result = buildEdgeLineImage(gray, w, h, blurRadius, edgeThreshold);
      lineImg = result.lineImg;
      edgeMag = result.mag;
      // binary shown in debug = edge magnitudes for reference
      binary = edgeMag;
    } else {
      self.postMessage({ type: 'progress', step: 'Thresholding image (Otsu)…', pct: 5 });
      thr = otsuThreshold(gray);
      binary = new Uint8Array(n);
      for (let i = 0; i < n; i++) binary[i] = gray[i] > thr ? 255 : 0;
      lineImg = new Uint8Array(n);
      for (let i = 0; i < n; i++) lineImg[i] = 255 - binary[i];
    }

    // ── 2. Seal line gaps ──────────────────────────
    self.postMessage({ type: 'progress', step: 'Sealing line gaps…', pct: 15 });
    const sealedLine = morphClose(lineImg, w, h, params.gapCloseKernel, params.gapCloseIters);

    // ── 3. Extract enclosed regions ────────────────
    self.postMessage({ type: 'progress', step: 'Extracting enclosed regions…', pct: 30 });
    // Open space = inverse of sealedLine
    const openSpace = new Uint8Array(n);
    for (let i = 0; i < n; i++) openSpace[i] = sealedLine[i] ? 0 : 255;
    const regionsMask = floodFillBackground(openSpace, w, h);

    // ── 4. Label connected components ─────────────
    self.postMessage({ type: 'progress', step: 'Labeling connected components…', pct: 42 });
    const { labels, nRegions, centroids } = labelRegions(regionsMask, w, h, params.minRegionArea);

    if (nRegions === 0) {
      self.postMessage({
        type: 'error',
        message: 'No enclosed regions found. Make sure your image has closed outlines (like a map or coloring book page). Try reducing "Min Region Area" or increasing "Gap Close Kernel".',
      });
      return;
    }

    // ── 5. Build adjacency graph ───────────────────
    self.postMessage({ type: 'progress', step: `Building adjacency graph (${nRegions} regions)…`, pct: 55 });
    const autoProbe = estimateAutoProbe(sealedLine, w, h);
    const maxProbe = Math.min(autoProbe, params.maxProbe || 96);
    const { adj, edgePos } = buildAdjacency(labels, sealedLine, w, h, nRegions, maxProbe, params.minBorderPixels);

    let nEdges = 0;
    for (let i = 1; i <= nRegions; i++) nEdges += adj[i].size;
    nEdges = nEdges / 2;

    // ── 6. 4-color the graph ───────────────────────
    self.postMessage({ type: 'progress', step: 'Solving 4-coloring (DSATUR)…', pct: 75 });
    const colors = fourColor(adj, nRegions);

    // ── 7. Render colored map pixels ───────────────
    self.postMessage({ type: 'progress', step: 'Rendering…', pct: 90 });

    const coloredPixels = new Uint8ClampedArray(n * 4);
    // Default to white background
    for (let i = 0; i < n * 4; i += 4) { coloredPixels[i] = 255; coloredPixels[i+1] = 255; coloredPixels[i+2] = 255; coloredPixels[i+3] = 255; }

    // Paint region colors
    for (let i = 0; i < n; i++) {
      const rid = labels[i];
      if (rid > 0) {
        const [r, g, b] = PALETTE[colors[rid]];
        coloredPixels[i * 4] = r;
        coloredPixels[i * 4 + 1] = g;
        coloredPixels[i * 4 + 2] = b;
        coloredPixels[i * 4 + 3] = 255;
      }
    }

    // Paint barrier lines on top (black)
    for (let i = 0; i < n; i++) {
      if (sealedLine[i] === 255) {
        coloredPixels[i * 4] = 0;
        coloredPixels[i * 4 + 1] = 0;
        coloredPixels[i * 4 + 2] = 0;
        coloredPixels[i * 4 + 3] = 255;
      }
    }

    // Find region border pixels (for pink outline overlay)
    const borderSet = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      const rid = labels[i];
      if (!rid) continue;
      const y = (i / w) | 0, x = i % w;
      if (
        (y > 0   && labels[i - w] !== rid) ||
        (y < h-1 && labels[i + w] !== rid) ||
        (x > 0   && labels[i - 1] !== rid) ||
        (x < w-1 && labels[i + 1] !== rid)
      ) borderSet[i] = 1;
    }

    // ── 8. Build graph visualization data ─────────
    const nodes = [];
    for (let rid = 1; rid <= nRegions; rid++) {
      nodes.push({
        id: rid,
        x: centroids[rid * 2],
        y: centroids[rid * 2 + 1],
        colorIdx: colors[rid],
        degree: adj[rid].size,
      });
    }
    const edges = [];
    for (let a = 1; a <= nRegions; a++) {
      for (const b of adj[a]) {
        if (a < b) edges.push([a, b]);
      }
    }
    const edgeLabels = Object.entries(edgePos).map(([k, [x, y]]) => {
      const [a, b] = k.split(',').map(Number);
      return { a, b, x, y };
    });

    // Color usage stats
    const colorCounts = [0, 0, 0, 0];
    for (let rid = 1; rid <= nRegions; rid++) colorCounts[colors[rid]]++;
    const colorsUsed = colorCounts.filter(c => c > 0).length;

    // ── 9. Debug images ────────────────────────────
    // Step 1 label depends on mode
    const step1Label = params.preprocessMode === 'edge' ? 'Edge Magnitude (Sobel)' : 'Binary (Otsu threshold)';
    const binaryRGBA    = grayToRGBA(binary, n);
    const sealedRGBA    = grayToRGBA(sealedLine, n);
    const regionsRGBA   = grayToRGBA(regionsMask, n);
    const labelsRGBA    = labelsToRGBA(labels, nRegions, w, h);

    // ── Transfer result ────────────────────────────
    const result = {
      type: 'result',
      width: w,
      height: h,
      coloredPixels,
      borderSet,
      graphData: { nodes, edges, edgeLabels },
      centroids,
      stats: {
        nRegions,
        nEdges: Math.round(nEdges),
        autoProbe,
        maxProbe,
        threshold: thr,
        colorsUsed,
        colorCounts,
        preprocessMode: params.preprocessMode ?? 'lineart',
        step1Label,
      },
      debugImages: {
        binary: binaryRGBA,
        sealedLine: sealedRGBA,
        regions: regionsRGBA,
        labels: labelsRGBA,
      },
    };

    // Transfer ownership of large typed arrays for zero-copy transfer
    self.postMessage(result, [
      coloredPixels.buffer,
      borderSet.buffer,
      binaryRGBA.buffer,
      sealedRGBA.buffer,
      regionsRGBA.buffer,
      labelsRGBA.buffer,
    ]);

  } catch (err) {
    self.postMessage({ type: 'error', message: err.message });
  }
};
