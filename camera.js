// Page 3: webcam. Each mapping set has a homography relating the camera image
// to the true geometry, defined by where that set's reference points A–D are
// seen in the camera image (its four draggable handles).
//
//   true geometry -> camera : draws each set's polygons over the video
//   camera -> true geometry : maps detected points back, and broadcasts them
//
// A detected camera point is tried against every set. It is attributed to the
// sets where it lands inside one of that set's polygons; failing that, to the
// sets whose A–D outline contains it; failing that, to the active set.
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
  const setSelect = document.getElementById('set');

  // Small offscreen copy of each frame for the pixel-based detectors.
  const probe = document.createElement('canvas');
  const probeCtx = probe.getContext('2d', { willReadFrequently: true });
  const PROBE_W = 160;

  let stream = null;
  let frame = { x: 0, y: 0, w: 1, h: 1 }; // where the video is drawn on the canvas
  let dragging = null;     // { set, index }
  let pointer = null;      // hovered point, normalised to the video frame
  let prevLuma = null;     // earlier frame, for motion detection
  let prevTime = 0;
  let lastSent = '[]';

  const toPx = ([x, y]) => [frame.x + x * frame.w, frame.y + y * frame.h];
  const toNorm = (x, y) => [(x - frame.x) / frame.w, (y - frame.y) / frame.h];
  const handlesPx = (set) => PM.quad('camera', set).map(toPx);
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
  document.getElementById('reset').onclick = () => PM.resetQuad('camera', PM.activeSet());
  setSelect.onchange = () => PM.setActive(setSelect.value);
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

    if (document.activeElement !== setSelect) PM.fillSetSelect(setSelect, state.active);

    // Both directions of every set's camera homography.
    const active = PM.activeSet();
    const maps = PM.sets().map((set) => {
      const quad = PM.quad('camera', set);
      const worldToCam = PM.solveHomography(set.refs, quad);
      return { set, quad, worldToCam, camToWorld: PM.invertHomography(worldToCam) };
    });

    // Detect in camera space, convert to true geometry, broadcast on change.
    const found = [];
    if (pointer) found.push({ source: 'pointer', cam: pointer });
    const auto = detect();
    if (auto) found.push({ source: modeEl.value, cam: auto });

    state.detections = [];
    for (const f of found) {
      const candidates = [];
      for (const m of maps) {
        const world = PM.applyHomography(m.camToWorld, f.cam);
        if (!world) continue;
        const d = { x: world[0], y: world[1], source: f.source, setId: m.set.id };
        const rank = PM.polygonsAt(d).length ? 2 : PM.pointInPolygon(f.cam, m.quad) ? 1 : m.set === active ? 0 : -1;
        candidates.push({ d, rank });
      }
      const best = Math.max(-1, ...candidates.map((c) => c.rank));
      if (best >= 0) state.detections.push(...candidates.filter((c) => c.rank === best).map((c) => c.d));
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
    for (const m of maps) {
      PM.drawPolygons(ctx, (p) => {
        const c = PM.applyHomography(m.worldToCam, p);
        return c && toPx(c);
      }, { setId: m.set.id });
    }
    ctx.restore();

    for (const f of found) PM.drawDetection(ctx, ...toPx(f.cam));

    // Active set last so its handles sit on top.
    for (const set of [...PM.sets().filter((s) => s !== active), active]) PM.drawQuad(ctx, handlesPx(set), set);

    if (!maps.find((m) => m.set === active).worldToCam) {
      PM.drawLabel(ctx, `${active.name}: reference points are degenerate — move a corner.`, w / 2, frame.y + 20, '#ff6b6b');
    }

    requestAnimationFrame(tick);
  }

  function updateReadout() {
    readoutEl.textContent = PM.describeDetections();
  }

  // ---- Handle dragging and pointer probe ----------------------------------

  function pointerPos(e) {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  canvas.addEventListener('pointerdown', (e) => {
    dragging = PM.pickHandle(handlesPx, ...pointerPos(e), 16);
    if (!dragging) return;
    canvas.setPointerCapture(e.pointerId);
    PM.setActive(dragging.set.id); // grabbing a handle makes its set the active one
  });

  canvas.addEventListener('pointermove', (e) => {
    const [x, y] = pointerPos(e);
    const [nx, ny] = toNorm(x, y);
    if (dragging) {
      PM.quad('camera', dragging.set)[dragging.index] = [Math.max(0, Math.min(1, nx)), Math.max(0, Math.min(1, ny))];
      PM.publish('camera');
      pointer = null;
      return;
    }
    const inside = nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1;
    pointer = inside ? [nx, ny] : null;
    canvas.style.cursor = PM.pickHandle(handlesPx, x, y, 16) ? 'grab' : 'crosshair';
  });

  canvas.addEventListener('pointerup', () => { dragging = null; });
  canvas.addEventListener('pointercancel', () => { dragging = null; });
  canvas.addEventListener('pointerleave', () => { pointer = null; });

  // Don't leave a stale marker on the other pages when this one closes.
  window.addEventListener('pagehide', () => {
    state.detections = [];
    PM.publish('detections');
  });

  PM.init(['camera', 'detections'], (topic) => { if (topic === 'geometry') updateReadout(); });
  requestAnimationFrame(tick);
})();
