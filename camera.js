// Page 3: webcam. A second homography relates the camera image to the true
// geometry. It is defined by where the reference points A–D (true geometry)
// are seen in the camera image, set by dragging the four handles.
//
//   true geometry -> camera : draws the polygons over the video
//   camera -> true geometry : maps detected points back, and broadcasts them
//
// Camera coordinates are normalised (0..1) to the video frame so they do not
// depend on how large the video is drawn.

(() => {
  const { state } = PM;
  const canvas = document.getElementById('canvas');
  const video = document.getElementById('video');
  const startBtn = document.getElementById('start');
  const statusEl = document.getElementById('status');
  const modeEl = document.getElementById('mode');
  const sensitivityEl = document.getElementById('sensitivity');
  const readoutEl = document.getElementById('readout');

  // Small offscreen copy of each frame for the pixel-based detectors.
  const probe = document.createElement('canvas');
  const probeCtx = probe.getContext('2d', { willReadFrequently: true });
  const PROBE_W = 160;

  let stream = null;
  let frame = { x: 0, y: 0, w: 1, h: 1 }; // where the video is drawn on the canvas
  let dragging = -1;
  let pointer = null;      // hovered point, normalised to the video frame
  let prevLuma = null;     // earlier frame, for motion detection
  let prevTime = 0;
  let lastSent = '[]';

  const toPx = ([x, y]) => [frame.x + x * frame.w, frame.y + y * frame.h];
  const toNorm = (x, y) => [(x - frame.x) / frame.w, (y - frame.y) / frame.h];
  const live = () => stream && video.videoWidth > 0;

  // ---- Webcam -----------------------------------------------------------

  async function start() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'environment' },
        audio: false,
      });
      video.srcObject = stream;
      await video.play();
      startBtn.textContent = 'Stop webcam';
      statusEl.textContent = '';
    } catch (err) {
      stream = null;
      statusEl.textContent = navigator.mediaDevices
        ? `Could not start the webcam: ${err.message}`
        : 'Webcam access needs a secure page — serve this folder from http://localhost.';
    }
  }

  function stop() {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
    video.srcObject = null;
    prevLuma = null;
    startBtn.textContent = 'Start webcam';
  }

  startBtn.onclick = () => (stream ? stop() : start());
  document.getElementById('reset').onclick = () => PM.reset('camera');
  modeEl.onchange = () => { prevLuma = null; };

  // ---- Detection --------------------------------------------------------

  // Returns one point normalised to the video frame, or null.
  function detect() {
    const mode = modeEl.value;
    if (mode === 'none' || !live()) return null;

    const pw = PROBE_W, ph = Math.max(1, Math.round((PROBE_W * video.videoHeight) / video.videoWidth));
    if (probe.width !== pw || probe.height !== ph) { probe.width = pw; probe.height = ph; prevLuma = null; }
    probeCtx.drawImage(video, 0, 0, pw, ph);
    const rgba = probeCtx.getImageData(0, 0, pw, ph).data;
    const luma = new Uint8Array(pw * ph);
    for (let i = 0; i < luma.length; i++) {
      luma[i] = (rgba[i * 4] * 3 + rgba[i * 4 + 1] * 6 + rgba[i * 4 + 2]) / 10;
    }

    const sensitivity = sensitivityEl.value / 100; // 0..1
    let sx = 0, sy = 0, n = 0;
    const add = (i) => { sx += i % pw; sy += Math.floor(i / pw); n++; };

    if (mode === 'bright') {
      // Centroid of the pixels close to the brightest value, if bright enough.
      const floor = 250 - sensitivity * 120;
      let max = 0;
      for (let i = 0; i < luma.length; i++) if (luma[i] > max) max = luma[i];
      if (max >= floor) for (let i = 0; i < luma.length; i++) if (luma[i] >= max - 8) add(i);
    } else {
      // Centroid of the pixels that changed since a frame ~100 ms ago.
      const threshold = 90 - sensitivity * 75;
      if (prevLuma) for (let i = 0; i < luma.length; i++) if (Math.abs(luma[i] - prevLuma[i]) > threshold) add(i);
      if (!prevLuma || performance.now() - prevTime > 100) { prevLuma = luma; prevTime = performance.now(); }
      if (n < 12) n = 0; // ignore sensor noise
    }
    return n ? [(sx / n + 0.5) / pw, (sy / n + 0.5) / ph] : null;
  }

  // ---- Frame loop -------------------------------------------------------

  function tick() {
    const { ctx, w, h } = PM.fitCanvas(canvas);

    // Letterbox the video (or a 16:9 placeholder) into the canvas.
    const aspect = live() ? video.videoWidth / video.videoHeight : 16 / 9;
    const fw = Math.min(w, h * aspect), fh = fw / aspect;
    frame = { x: (w - fw) / 2, y: (h - fh) / 2, w: fw, h: fh };

    ctx.clearRect(0, 0, w, h);
    if (live()) {
      ctx.drawImage(video, frame.x, frame.y, frame.w, frame.h);
    } else {
      ctx.fillStyle = '#0e1013';
      ctx.fillRect(frame.x, frame.y, frame.w, frame.h);
      PM.drawLabel(ctx, 'Webcam not started', w / 2, h / 2, '#6f7785');
    }

    // The two directions of the camera homography.
    const worldToCam = PM.solveHomography(state.geometry.refs, state.camera);
    const camToWorld = PM.invertHomography(worldToCam);
    const mapToCanvas = (p) => {
      const c = PM.applyHomography(worldToCam, p);
      return c && toPx(c);
    };

    // Detect in camera space, convert to true geometry, broadcast on change.
    const found = [];
    if (pointer) found.push({ source: 'pointer', cam: pointer });
    const auto = detect();
    if (auto) found.push({ source: modeEl.value, cam: auto });

    state.detections = [];
    for (const f of found) {
      const world = PM.applyHomography(camToWorld, f.cam);
      if (world) state.detections.push({ x: world[0], y: world[1], source: f.source });
    }
    const json = JSON.stringify(state.detections);
    if (json !== lastSent) {
      lastSent = json;
      PM.publish('detections');
      updateReadout();
    }

    // Overlay
    ctx.save();
    ctx.beginPath();
    ctx.rect(frame.x, frame.y, frame.w, frame.h);
    ctx.clip();
    PM.drawPolygons(ctx, mapToCanvas);
    ctx.restore();

    for (const f of found) PM.drawDetection(ctx, ...toPx(f.cam));

    const handles = state.camera.map(toPx);
    ctx.beginPath();
    handles.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(255,225,77,0.5)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);
    handles.forEach(([x, y], i) => PM.drawHandle(ctx, x, y, PM.REF_LABELS[i]));

    if (!worldToCam) PM.drawLabel(ctx, 'Reference points are degenerate — move a corner.', w / 2, frame.y + 20, '#ff6b6b');

    requestAnimationFrame(tick);
  }

  function updateReadout() {
    if (!state.detections.length) { readoutEl.textContent = '—'; return; }
    readoutEl.textContent = state.detections.map((d) => {
      const inside = state.geometry.polygons
        .filter((p) => PM.pointInPolygon([d.x, d.y], p.points))
        .map((p) => p.name || '(unnamed)');
      return `${d.source}: (${Math.round(d.x)}, ${Math.round(d.y)})` + (inside.length ? `\n  in ${inside.join(', ')}` : '');
    }).join('\n');
  }

  // ---- Handle dragging and pointer probe ----------------------------------

  function pointerPos(e) {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  canvas.addEventListener('pointerdown', (e) => {
    dragging = PM.pick(state.camera.map(toPx), ...pointerPos(e), 16);
    if (dragging >= 0) canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointermove', (e) => {
    const [x, y] = pointerPos(e);
    const [nx, ny] = toNorm(x, y);
    if (dragging >= 0) {
      state.camera[dragging] = [Math.max(0, Math.min(1, nx)), Math.max(0, Math.min(1, ny))];
      PM.publish('camera');
      pointer = null;
      return;
    }
    const inside = nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1;
    pointer = inside ? [nx, ny] : null;
    canvas.style.cursor = PM.pick(state.camera.map(toPx), x, y, 16) >= 0 ? 'grab' : 'crosshair';
  });

  canvas.addEventListener('pointerup', () => { dragging = -1; });
  canvas.addEventListener('pointercancel', () => { dragging = -1; });
  canvas.addEventListener('pointerleave', () => { pointer = null; });

  // Don't leave a stale marker on the other pages when this one closes.
  window.addEventListener('pagehide', () => {
    state.detections = [];
    PM.publish('detections');
  });

  PM.init(['camera', 'detections'], (topic) => { if (topic === 'geometry') updateReadout(); });
  requestAnimationFrame(tick);
})();
