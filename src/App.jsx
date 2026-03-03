import { useState, useRef, useEffect, useCallback } from 'react';
import './index.scss';

const PALETTE = [
  [60, 180, 75],
  [230, 25, 75],
  [255, 225, 25],
  [0, 130, 200],
];
const PALETTE_HEX = PALETTE.map(([r, g, b]) =>
  `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`
);
const COLOR_NAMES = ['Green', 'Red', 'Yellow', 'Blue'];

const DEFAULT_PARAMS = {
  gapCloseKernel: 3,
  gapCloseIters: 1,
  minRegionArea: 50,
  minBorderPixels: 20,
  maxProbe: 96,
  preprocessMode: 'lineart',
  blurRadius: 2,
  edgeThreshold: 30,
};

const MAX_DIM = 1200;

// ─── Small components ──────────────────────────────

function ParamRow({ label, hint, min, max, step, value, onChange }) {
  return (
    <div className="param-row">
      <div className="param-label">
        <span>{label}</span>
        <span className="param-value">{value}</span>
      </div>
      <input
        className="param-slider"
        type="range" min={min} max={max} step={step} value={value}
        onChange={e => onChange(Number(e.target.value))}
      />
      {hint && <div className="param-hint">{hint}</div>}
    </div>
  );
}

function StatBadge({ label, value, color }) {
  return (
    <div className="stat-badge" style={{ borderColor: color + '55' }}>
      <span className="stat-value" style={{ color }}>{value}</span>
      <span className="stat-label">{label}</span>
    </div>
  );
}

// ─── Canvas rendering helpers ──────────────────────

function renderColoredMap(result, canvas) {
  const { width: w, height: h, coloredPixels, borderSet, graphData, centroids, stats } = result;
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(coloredPixels), w, h), 0, 0);

  // Pink region borders
  const img2 = ctx.getImageData(0, 0, w, h);
  const d = img2.data;
  for (let i = 0; i < w * h; i++) {
    if (borderSet[i]) { d[i * 4] = 255; d[i * 4 + 1] = 20; d[i * 4 + 2] = 220; d[i * 4 + 3] = 255; }
  }
  ctx.putImageData(img2, 0, 0);

  // Region IDs
  ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  for (let rid = 1; rid <= stats.nRegions; rid++) {
    const x = centroids[rid * 2], y = centroids[rid * 2 + 1];
    if (x <= 0 || y <= 0) continue;
    ctx.font = 'bold 13px "Space Mono", monospace';
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(String(rid), x, y);
    ctx.fillStyle = '#fff'; ctx.fillText(String(rid), x, y);
  }

  // Edge labels
  for (const { a, b, x, y } of graphData.edgeLabels) {
    ctx.font = 'bold 10px "Space Mono", monospace';
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(`${a}-${b}`, x, y);
    ctx.fillStyle = '#ff14e0'; ctx.fillText(`${a}-${b}`, x, y);
  }
}

function renderGraphPanel(result, canvas) {
  const { width: w, height: h, graphData, stats } = result;
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#0e0e14'; ctx.fillRect(0, 0, w, h);

  const { nodes, edges } = graphData;
  if (!nodes.length) return;

  const margin = Math.min(w, h) * 0.1;
  const uw = w - 2 * margin, uh = h - 2 * margin;
  const xs = nodes.map(n => n.x), ys = nodes.map(n => n.y);
  const xMin = Math.min(...xs), xMax = Math.max(...xs);
  const yMin = Math.min(...ys), yMax = Math.max(...ys);
  const dx = Math.max(1, xMax - xMin), dy = Math.max(1, yMax - yMin);

  const pos = {};
  for (const node of nodes) {
    pos[node.id] = [
      margin + (node.x - xMin) / dx * uw,
      margin + (node.y - yMin) / dy * uh,
    ];
  }

  const radius = Math.max(5, Math.min(20, Math.round(Math.min(w, h) / 45)));
  const smallText = nodes.length > 100;

  ctx.font = '11px "Space Mono", monospace'; ctx.fillStyle = '#444466';
  ctx.textAlign = 'left';
  ctx.fillText(`Adjacency Graph  ·  ${stats.nRegions} nodes  ·  ${stats.nEdges} edges`, margin, Math.max(18, margin * 0.5));

  ctx.strokeStyle = '#1e1e2c'; ctx.lineWidth = 1;
  for (const [a, b] of edges) {
    if (!pos[a] || !pos[b]) continue;
    ctx.beginPath(); ctx.moveTo(pos[a][0], pos[a][1]); ctx.lineTo(pos[b][0], pos[b][1]); ctx.stroke();
  }

  for (const node of nodes) {
    if (!pos[node.id]) continue;
    const [x, y] = pos[node.id];
    const [r, g, b] = PALETTE[node.colorIdx];
    ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2);
    ctx.fillStyle = `rgb(${r},${g},${b})`; ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.15)'; ctx.lineWidth = 1.5; ctx.stroke();
    if (!smallText) {
      const fs = Math.max(7, radius - 3);
      ctx.font = `bold ${fs}px "Space Mono", monospace`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.lineWidth = 2; ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.strokeText(String(node.id), x, y);
      ctx.fillStyle = '#fff'; ctx.fillText(String(node.id), x, y);
    }
  }

  const legendY = h - margin * 0.55;
  let legendX = margin;
  for (let i = 0; i < 4; i++) {
    if (stats.colorCounts[i] === 0) continue;
    const [r, g, b] = PALETTE[i];
    ctx.beginPath(); ctx.arc(legendX + 5, legendY, 5, 0, Math.PI * 2);
    ctx.fillStyle = `rgb(${r},${g},${b})`; ctx.fill();
    ctx.font = '10px "Space Mono", monospace'; ctx.fillStyle = '#555568'; ctx.textAlign = 'left';
    ctx.fillText(`${COLOR_NAMES[i]} ×${stats.colorCounts[i]}`, legendX + 14, legendY + 4);
    legendX += 100;
  }
}

function renderPipelineThumb(rgba, label, w, h, canvas) {
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), w, h), 0, 0);
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(0, 0, w, 22);
  ctx.font = 'bold 10px "Space Mono", monospace';
  ctx.fillStyle = '#bbb';
  ctx.textAlign = 'left'; ctx.textBaseline = 'top';
  ctx.fillText(label, 6, 6);
}

function downsampleImageData(img, maxDim) {
  let w = img.width, h = img.height;
  if (w <= maxDim && h <= maxDim) return { imageData: img, w, h };
  const scale = maxDim / Math.max(w, h);
  w = Math.round(w * scale); h = Math.round(h * scale);
  const tmp = document.createElement('canvas');
  tmp.width = img.width; tmp.height = img.height;
  tmp.getContext('2d').putImageData(img, 0, 0);
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  c.getContext('2d').drawImage(tmp, 0, 0, w, h);
  return { imageData: c.getContext('2d').getImageData(0, 0, w, h), w, h };
}

// ─── Pipeline Strip ────────────────────────────────

function PipelineStrip({ result, visible }) {
  const refs = [useRef(null), useRef(null), useRef(null), useRef(null)];

  const steps = result ? [
    { rgba: result.debugImages.binary, label: result.stats.step1Label || 'Binary / Edges' },
    { rgba: result.debugImages.sealedLine, label: 'Sealed Lines' },
    { rgba: result.debugImages.regions, label: 'Enclosed Regions' },
    { rgba: result.debugImages.labels, label: 'Labeled Regions' },
  ] : [];

  useEffect(() => {
    if (!result || !visible) return;
    steps.forEach(({ rgba, label }, i) => {
      const c = refs[i].current;
      if (c && rgba) renderPipelineThumb(rgba, label, result.width, result.height, c);
    });
  }, [result, visible]);

  if (!visible || !result) return null;

  return (
    <div className="pipeline-strip">
      {steps.map(({ label }, i) => (
        <div key={i} className="pipeline-thumb-box">
          <div className="pipeline-step-badge">
            <span className="pipeline-step-num">0{i + 1}</span>
            <span className="pipeline-step-name">{label}</span>
          </div>
          <canvas ref={refs[i]} className="pipeline-thumb-canvas" />
        </div>
      ))}
    </div>
  );
}

// ─── App ───────────────────────────────────────────

export default function App() {
  const [inputImage, setInputImage] = useState(null);
  const [params, setParams] = useState(DEFAULT_PARAMS);
  const [processing, setProcessing] = useState(false);
  const [progress, setProgress] = useState({ step: '', pct: 0 });
  const [result, setResult] = useState(null);
  const [error, setError] = useState(null);
  const [showPipeline, setShowPipeline] = useState(false);
  const [showWebcam, setShowWebcam] = useState(false);
  const [stream, setStream] = useState(null);
  const [dragging, setDragging] = useState(false);
  const [liveMode, setLiveMode] = useState(false);
  const [liveFps, setLiveFps] = useState(null); // measured fps for display

  const workerRef = useRef(null);
  const mapCanvasRef = useRef(null);
  const graphCanvasRef = useRef(null);
  const videoRef = useRef(null);
  const fileInputRef = useRef(null);
  // Refs that live-mode loop reads without stale closures
  const liveModeRef = useRef(false);
  const paramsRef = useRef(DEFAULT_PARAMS);
  const liveTimerRef = useRef(null);
  const liveFrameStartRef = useRef(null); // for fps measurement

  // Keep paramsRef in sync so live loop always uses latest params
  useEffect(() => { paramsRef.current = params; }, [params]);

  useEffect(() => {
    const worker = new Worker(
      new URL('./colormap.worker.js', import.meta.url),
      { type: 'module' }
    );
    worker.onmessage = ({ data }) => {
      if (data.type === 'progress') {
        setProgress({ step: data.step, pct: data.pct });
      } else if (data.type === 'result') {
        // Measure fps in live mode
        if (liveFrameStartRef.current) {
          const elapsed = performance.now() - liveFrameStartRef.current;
          setLiveFps(Math.round(1000 / elapsed * 10) / 10);
        }
        setResult(data);
        setProcessing(false);
        setProgress({ step: 'Done', pct: 100 });
        // Schedule next live frame after 500ms cooldown
        if (liveModeRef.current) {
          liveTimerRef.current = setTimeout(() => {
            if (liveModeRef.current) grabAndProcessLive();
          }, 500);
        }
      } else if (data.type === 'error') {
        setError(data.message);
        setProcessing(false);
        setShowPipeline(true);
        // Auto-stop live mode on error
        if (liveModeRef.current) {
          liveModeRef.current = false;
          setLiveMode(false);
        }
      }
    };
    workerRef.current = worker;
    return () => worker.terminate();
  }, []);

  // Grab a frame from video and send directly to worker (no setInputImage round-trip)
  const grabAndProcessLive = useCallback(() => {
    const v = videoRef.current;
    if (!v || !v.videoWidth || !workerRef.current) return;
    liveFrameStartRef.current = performance.now();
    const tmp = document.createElement('canvas');
    tmp.width = v.videoWidth; tmp.height = v.videoHeight;
    tmp.getContext('2d').drawImage(v, 0, 0);
    const raw = tmp.getContext('2d').getImageData(0, 0, v.videoWidth, v.videoHeight);
    const { imageData } = downsampleImageData(raw, MAX_DIM);
    setProcessing(true);
    setError(null);
    setProgress({ step: 'Starting…', pct: 0 });
    workerRef.current.postMessage({ imageData, params: paramsRef.current });
  }, []);

  const startLive = useCallback(() => {
    clearTimeout(liveTimerRef.current);
    liveModeRef.current = true;
    setLiveMode(true);
    setLiveFps(null);
    // Ensure edge mode is on for live camera
    setParams(p => {
      const next = { ...p, preprocessMode: 'edge' };
      paramsRef.current = next;
      return next;
    });
    grabAndProcessLive();
  }, [grabAndProcessLive]);

  const stopLive = useCallback(() => {
    clearTimeout(liveTimerRef.current);
    liveModeRef.current = false;
    setLiveMode(false);
    setLiveFps(null);
  }, []);

  const loadFile = useCallback((file) => {
    if (!file || !file.type.startsWith('image/')) return;
    stopLive();
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const tmp = document.createElement('canvas');
      tmp.width = img.width; tmp.height = img.height;
      tmp.getContext('2d').drawImage(img, 0, 0);
      const raw = tmp.getContext('2d').getImageData(0, 0, img.width, img.height);
      const { imageData, w, h } = downsampleImageData(raw, MAX_DIM);
      const prev = document.createElement('canvas');
      prev.width = w; prev.height = h;
      prev.getContext('2d').putImageData(imageData, 0, 0);
      URL.revokeObjectURL(url);
      setInputImage({ url: prev.toDataURL(), imageData, w, h });
      setResult(null); setError(null);
    };
    img.src = url;
  }, [stopLive]);

  const processImage = useCallback(() => {
    if (!inputImage || !workerRef.current || processing) return;
    setProcessing(true);
    setResult(null);
    setError(null);
    setProgress({ step: 'Starting…', pct: 0 });
    workerRef.current.postMessage({ imageData: inputImage.imageData, params });
  }, [inputImage, params, processing]);

  const startWebcam = useCallback(async () => {
    try {
      const s = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 } }
      });
      setStream(s);
      setShowWebcam(true);
      // Auto-switch to edge mode when opening webcam
      setParams(p => ({ ...p, preprocessMode: 'edge' }));
    } catch (e) {
      setError('Camera error: ' + e.message);
    }
  }, []);

  const stopWebcam = useCallback(() => {
    stopLive();
    if (stream) stream.getTracks().forEach(t => t.stop());
    setStream(null);
    setShowWebcam(false);
  }, [stream, stopLive]);

  useEffect(() => {
    if (videoRef.current && stream) videoRef.current.srcObject = stream;
  }, [stream]);

  // Cleanup live timer on unmount
  useEffect(() => () => clearTimeout(liveTimerRef.current), []);

  const captureFrame = useCallback(() => {
    const v = videoRef.current;
    if (!v) return;
    stopLive();
    const tmp = document.createElement('canvas');
    tmp.width = v.videoWidth; tmp.height = v.videoHeight;
    tmp.getContext('2d').drawImage(v, 0, 0);
    const raw = tmp.getContext('2d').getImageData(0, 0, v.videoWidth, v.videoHeight);
    const { imageData, w, h } = downsampleImageData(raw, MAX_DIM);
    const prev = document.createElement('canvas');
    prev.width = w; prev.height = h;
    prev.getContext('2d').putImageData(imageData, 0, 0);
    setInputImage({ url: prev.toDataURL(), imageData, w, h });
    setResult(null); setError(null);
    setParams(p => ({ ...p, preprocessMode: 'edge' }));
    stopWebcam();
  }, [stopLive, stopWebcam]);

  const handleDragOver = (e) => { e.preventDefault(); setDragging(true); };
  const handleDragLeave = () => setDragging(false);
  const handleDrop = useCallback((e) => {
    e.preventDefault(); setDragging(false);
    const file = e.dataTransfer.files[0];
    if (file) loadFile(file);
  }, [loadFile]);

  useEffect(() => {
    if (!result) return;
    if (mapCanvasRef.current) renderColoredMap(result, mapCanvasRef.current);
    if (graphCanvasRef.current) renderGraphPanel(result, graphCanvasRef.current);
  }, [result]);

  const isEdgeMode = params.preprocessMode === 'edge';
  const colorsUsed = result?.stats?.colorsUsed ?? 0;

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <div className="logo-cluster">
            {PALETTE.map(([r, g, b], i) => (
              <span key={i} className="logo-diamond" style={{ background: `rgb(${r},${g},${b})` }} />
            ))}
          </div>
          <div>
            <h1 className="header-title">Four Color Map</h1>
            <p className="header-sub">theorem visualizer</p>
          </div>
        </div>
        {result && (
          <div className="header-stats">
            <StatBadge label="regions" value={result.stats.nRegions} color={PALETTE_HEX[2]} />
            <StatBadge label="edges" value={result.stats.nEdges} color={PALETTE_HEX[3]} />
            <StatBadge label="colors" value={colorsUsed} color={PALETTE_HEX[0]} />
            <StatBadge
              label="mode"
              value={result.stats.preprocessMode === 'edge' ? 'edge-detect' : 'threshold'}
              color="#556"
            />
            {liveMode && liveFps !== null && (
              <StatBadge label="fps" value={liveFps} color="#3cb44b" />
            )}
          </div>
        )}
      </header>

      <div className="body">
        <aside className="sidebar">

          {/* Input */}
          <div className="panel">
            <div className="panel-head"><span className="panel-title">Image Input</span></div>
            {!showWebcam ? (
              <div
                className={`dropzone ${dragging ? 'dragging' : ''} ${inputImage ? 'has-image' : ''}`}
                onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop}
                onClick={() => fileInputRef.current?.click()}
              >
                {inputImage ? (
                  <img src={inputImage.url} alt="input" className="preview-img" />
                ) : (
                  <div className="dropzone-empty">
                    <div className="drop-icon">
                      {['◈', '◉', '◆', '◇'].map((s, i) => (
                        <span key={i} style={{ color: PALETTE_HEX[i] }}>{s}</span>
                      ))}
                    </div>
                    <p className="drop-primary">Drop image or click to upload</p>
                    <p className="drop-secondary">Maps · diagrams · coloring book pages</p>
                  </div>
                )}
              </div>
            ) : (
              <div className="webcam-wrap">
                <video ref={videoRef} autoPlay playsInline muted className="webcam-video" />
                {liveMode && (
                  <div className="live-overlay">
                    <span className="live-dot" />
                    <span>LIVE{liveFps ? ` · ${liveFps} fps` : ''}</span>
                  </div>
                )}
              </div>
            )}
            <input ref={fileInputRef} type="file" accept="image/*" style={{ display: 'none' }}
              onChange={e => e.target.files[0] && loadFile(e.target.files[0])} />
            <div className="btn-row">
              {!showWebcam ? (
                <>
                  <button className="btn btn-outline" onClick={() => fileInputRef.current?.click()}>Upload</button>
                  <button className="btn btn-outline" onClick={startWebcam}>📷 Webcam</button>
                </>
              ) : (
                <>
                  <button
                    className={`btn btn-live ${liveMode ? 'live-active' : ''}`}
                    onClick={liveMode ? stopLive : startLive}
                  >
                    {liveMode ? (
                      <><span className="live-dot" /> Live</>
                    ) : '⊙ Go Live'}
                  </button>
                  {!liveMode && (
                    <button className="btn btn-primary" onClick={captureFrame}>Capture</button>
                  )}
                  <button className="btn btn-ghost" onClick={stopWebcam}>✕</button>
                </>
              )}
            </div>
          </div>

          {/* Preprocess mode toggle */}
          <div className="panel">
            <div className="panel-head"><span className="panel-title">Preprocess Mode</span></div>
            <div className="mode-toggle-wrap">
              <button
                className={`mode-btn ${!isEdgeMode ? 'active' : ''}`}
                onClick={() => setParams(p => ({ ...p, preprocessMode: 'lineart' }))}
              >
                <span className="mode-icon">◧</span>
                <span className="mode-info">
                  <span className="mode-label">Line Art</span>
                  <span className="mode-sub">Otsu threshold</span>
                </span>
              </button>
              <button
                className={`mode-btn ${isEdgeMode ? 'active' : ''}`}
                onClick={() => setParams(p => ({ ...p, preprocessMode: 'edge' }))}
              >
                <span className="mode-icon">◈</span>
                <span className="mode-info">
                  <span className="mode-label">Edge Detect</span>
                  <span className="mode-sub">Gaussian + Sobel</span>
                </span>
              </button>
            </div>
            {isEdgeMode && (
              <div className="mode-note">
                Auto-selected for webcam captures. Finds edges in color photos rather than requiring black ink on white paper.
              </div>
            )}
          </div>

          {/* Parameters */}
          <div className="panel">
            <div className="panel-head">
              <span className="panel-title">Parameters</span>
              <button className="btn-reset" onClick={() => setParams(DEFAULT_PARAMS)}>reset</button>
            </div>

            {isEdgeMode && (
              <>
                <ParamRow label="Blur Radius" hint="Gaussian blur before Sobel — reduces noise"
                  min={1} max={8} step={1} value={params.blurRadius}
                  onChange={v => setParams(p => ({ ...p, blurRadius: v }))} />
                <ParamRow label="Edge Threshold" hint="Sobel magnitude cutoff — lower = more edges detected"
                  min={5} max={120} step={5} value={params.edgeThreshold}
                  onChange={v => setParams(p => ({ ...p, edgeThreshold: v }))} />
                <div className="param-divider" />
              </>
            )}

            <ParamRow label="Gap Close Kernel" hint="Larger fills bigger gaps in stroke lines"
              min={1} max={11} step={2} value={params.gapCloseKernel}
              onChange={v => setParams(p => ({ ...p, gapCloseKernel: v }))} />
            <ParamRow label="Gap Close Iterations" hint="More passes = stronger gap sealing"
              min={1} max={5} step={1} value={params.gapCloseIters}
              onChange={v => setParams(p => ({ ...p, gapCloseIters: v }))} />
            <ParamRow label="Min Region Area (px)" hint="Ignore regions smaller than this"
              min={5} max={500} step={5} value={params.minRegionArea}
              onChange={v => setParams(p => ({ ...p, minRegionArea: v }))} />
            <ParamRow label="Min Border Pixels" hint="Adjacency sensitivity — higher = fewer graph edges"
              min={1} max={100} step={1} value={params.minBorderPixels}
              onChange={v => setParams(p => ({ ...p, minBorderPixels: v }))} />
          </div>

          {/* Analyze */}
          <button
            className={`btn btn-analyze ${processing ? 'analyzing' : ''}`}
            onClick={processImage} disabled={!inputImage || processing}
          >
            {processing ? (
              <span className="analyzing-label">
                <span className="spinner" />{progress.step}
              </span>
            ) : '▶  Analyze Image'}
          </button>

          {processing && (
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${progress.pct}%` }} />
            </div>
          )}

          {error && (
            <div className="error-box">
              <strong>⚠ Error</strong>
              <p>{error}</p>
              <p className="error-hint">Expand Pipeline Steps to diagnose where it broke down.</p>
            </div>
          )}

          {result && (
            <div className="panel">
              <div className="panel-head"><span className="panel-title">Color Usage</span></div>
              <div className="color-legend">
                {PALETTE.map(([r, g, b], i) => (
                  <div key={i} className="color-item">
                    <span className="color-dot" style={{ background: `rgb(${r},${g},${b})` }} />
                    <span className="color-name">{COLOR_NAMES[i]}</span>
                    <span className="color-count">{result.stats.colorCounts[i]}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </aside>

        {/* ── Results ──────────────────────────── */}
        <main className="results">
          {result ? (
            <div className="result-layout">
              <div className="canvas-area">
                <div className="canvas-pair">
                  <div className="canvas-box">
                    <div className="canvas-label">◈ Colored Map</div>
                    <canvas ref={mapCanvasRef} className="result-canvas" />
                  </div>
                  <div className="canvas-box">
                    <div className="canvas-label">⬡ Adjacency Graph</div>
                    <canvas ref={graphCanvasRef} className="result-canvas result-canvas-dark" />
                  </div>
                </div>
              </div>

              {/* Pipeline toggle */}
              <div className="pipeline-toggle-row">
                <button
                  className={`pipeline-toggle-btn ${showPipeline ? 'open' : ''}`}
                  onClick={() => setShowPipeline(v => !v)}
                >
                  <span>{showPipeline ? '▾' : '▸'}</span>
                  Pipeline Steps
                  <span className="pipeline-step-count">4 stages</span>
                </button>
              </div>

              <PipelineStrip result={result} visible={showPipeline} />
            </div>
          ) : (
            <div className="empty-state">
              <div className="empty-diamonds">
                {PALETTE.map(([r, g, b], i) => (
                  <div key={i} className="empty-diamond"
                    style={{ background: `rgb(${r},${g},${b})`, animationDelay: `${i * 0.2}s` }} />
                ))}
              </div>
              <h2 className="empty-title">Upload a map or drawing</h2>
              <p className="empty-body">
                Use <strong>Line Art</strong> mode for scanned drawings with dark ink on white.
                Use <strong>Edge Detect</strong> mode for webcam photos or color images — it finds
                edges via Sobel gradients instead of thresholding.
              </p>
              <div className="empty-steps">
                {[
                  ['01', 'Threshold (line art) or Sobel edges (photo) builds the line barrier'],
                  ['02', 'Morphological close seals small gaps in strokes'],
                  ['03', 'Flood fill from corner isolates enclosed regions'],
                  ['04', 'Probe rays detect adjacency across thick lines'],
                  ['05', 'DSATUR + backtracking assigns ≤4 colors'],
                ].map(([n, t]) => (
                  <div key={n} className="empty-step">
                    <span className="step-num">{n}</span>
                    <span className="step-text">{t}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}
