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
// Drawing here uses the same inverse: a corner clicked on the video is mapped
// through the active set's camera -> true geometry homography before it is
// stored, so polygons can be traced over what the camera sees.
//
// This tab is one camera "view" (?view=N). Each view keeps its own handles,
// its own choice of visible mapping sets and its own webcam, and publishes
// its detections separately, so several cameras can run in separate tabs.
// Hidden sets are neither drawn nor used for detection.
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
  const setsEl = document.getElementById('sets');
  const deviceEl = document.getElementById('device');
  const gridEl = document.getElementById('grid');
  const view = PM.openView('camera');

  // Small offscreen copy of each frame for the pixel-based detectors.
  const probe = document.createElement('canvas');
  const probeCtx = probe.getContext('2d', { willReadFrequently: true });
  const PROBE_W = 160;

  let stream = null;
  let frame = { x: 0, y: 0, w: 1, h: 1 }; // where the video is drawn on the canvas
  let pointer = null;      // hovered point, normalised to the video frame
  let prevLuma = null;     // earlier frame, for motion detection
  let prevTime = 0;
  let lastSent = '[]';
  let mine = [];           // this tab's current detections

  const toPx = ([x, y]) => [frame.x + x * frame.w, frame.y + y * frame.h];
  const toNorm = (x, y) => [(x - frame.x) / frame.w, (y - frame.y) / frame.h];
  const handlesPx = (set) => (view.visible(set) ? view.quad(set).map(toPx) : []); // hidden sets can't be grabbed
  const homography = (set) => PM.solveHomography(set.refs, view.quad(set)); // true geometry -> video frame

  const editor = PM.createEditor({
    canvas,
    toScreen(set, p) {
      const c = PM.applyHomography(homography(set), p);
      return c && toPx(c);
    },
    toWorld: (set, x, y) => PM.applyHomography(PM.invertHomography(homography(set)), toNorm(x, y)),
    handlesOf: handlesPx,
    moveHandle(set, index, x, y) {
      view.quad(set)[index] = toNorm(x, y).map((v) => Math.max(0, Math.min(1, v)));
      view.save();
    },
    visible: view.visible,
    onRefresh: refreshSets,
  });

  function refreshSets() {
    PM.renderSetToggles(setsEl, view, {
      onToggle: () => editor.refresh(),
      onActivate: (set) => editor.activate(set.id),
    });
  }
  const live = () => stream && video.videoWidth > 0;

  // ---- Webcam -----------------------------------------------------------

  async function start() {
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 1280 },
          height: { ideal: 720 },
          ...(view.data().device ? { deviceId: { exact: view.data().device } } : { facingMode: 'environment' }),
        },
        audio: false,
      });
      video.srcObject = stream;
      await video.play();
      await listDevices(); // labels are only available once permission is granted
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

  // Each camera view remembers which webcam it uses.
  async function listDevices() {
    const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
    deviceEl.innerHTML = '';
    deviceEl.add(new Option('Default webcam', ''));
    cams.forEach((d, i) => deviceEl.add(new Option(d.label || `Webcam ${i + 1}`, d.deviceId)));
    deviceEl.value = view.data().device || '';
  }

  deviceEl.onchange = async () => {
    view.data().device = deviceEl.value;
    view.save();
    if (stream) { stop(); await start(); }
  };

  gridEl.checked = view.data().grid !== false;
  gridEl.onchange = () => {
    view.data().grid = gridEl.checked;
    view.save();
  };

  startBtn.onclick = () => (stream ? stop() : start());
  document.getElementById('reset').onclick = () => view.resetQuad(PM.activeSet());
  PM.bindViewControls(view, 'Camera', document.getElementById('view'), document.getElementById('new-view'));
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

    // Both directions of every visible set's camera homography.
    const active = PM.activeSet();
    const maps = view.visibleSets().map((set) => {
      const quad = view.quad(set);
      const worldToCam = PM.solveHomography(set.refs, quad);
      return { set, quad, worldToCam, camToWorld: PM.invertHomography(worldToCam) };
    });

    // Detect in camera space, convert to true geometry, broadcast on change.
    const found = [];
    if (pointer) found.push({ source: 'pointer', cam: pointer });
    const auto = detect();
    if (auto) found.push({ source: modeEl.value, cam: auto });

    const detections = [];
    for (const f of found) {
      const candidates = [];
      for (const m of maps) {
        const world = PM.applyHomography(m.camToWorld, f.cam);
        if (!world) continue;
        const d = { x: world[0], y: world[1], source: f.source, setId: m.set.id, view: view.id };
        const rank = PM.polygonsAt(d).length ? 2 : PM.pointInPolygon(f.cam, m.quad) ? 1 : m.set === active ? 0 : -1;
        candidates.push({ d, rank });
      }
      const best = Math.max(-1, ...candidates.map((c) => c.rank));
      if (best >= 0) detections.push(...candidates.filter((c) => c.rank === best).map((c) => c.d));
    }
    const json = JSON.stringify(detections);
    if (json !== lastSent) {
      lastSent = json;
      mine = detections;
      PM.publishDetections(mine);
      updateReadout();
    }

    // Overlay
    ctx.save();
    ctx.beginPath();
    ctx.rect(frame.x, frame.y, frame.w, frame.h);
    ctx.clip();
    const activeMap = maps.find((m) => m.set === active);
    if (gridEl.checked && activeMap && activeMap.worldToCam) {
      // Straight to canvas pixels, so the grid can be clipped at the horizon.
      const toPixels = PM.solveHomography(active.refs, activeMap.quad.map(toPx));
      if (toPixels) PM.drawGrid(ctx, toPixels, frame, active.refs);
    }
    for (const m of maps) {
      PM.drawPolygons(ctx, (p) => {
        const c = PM.applyHomography(m.worldToCam, p);
        return c && toPx(c);
      }, { setId: m.set.id, selectedId: editor.selectedId });
    }
    ctx.restore();
    editor.drawOverlay(ctx);

    for (const f of found) PM.drawDetection(ctx, ...toPx(f.cam));

    // Active set last so its handles sit on top.
    for (const m of [...maps.filter((m) => m.set !== active), ...maps.filter((m) => m.set === active)]) {
      PM.drawQuad(ctx, m.quad.map(toPx), m.set);
    }

    if (maps.some((m) => m.set === active && !m.worldToCam)) {
      PM.drawLabel(ctx, `${active.name}: reference points are degenerate — move a corner.`, w / 2, frame.y + 20, '#ff6b6b');
    }

    requestAnimationFrame(tick);
  }

  function updateReadout() {
    readoutEl.textContent = PM.describeDetections();
  }

  // ---- Pointer probe ------------------------------------------------------
  // With the Edit tool, the hovered point stands in for a detection.

  canvas.addEventListener('pointermove', (e) => {
    const r = canvas.getBoundingClientRect();
    const [nx, ny] = toNorm(e.clientX - r.left, e.clientY - r.top);
    const inside = nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1;
    pointer = inside && editor.tool === 'edit' && !editor.busy ? [nx, ny] : null;
  });

  canvas.addEventListener('pointerleave', () => { pointer = null; });

  // Don't leave a stale marker on the other pages when this one closes.
  window.addEventListener('pagehide', () => PM.publishDetections([]));

  PM.init((topic, key) => {
    editor.sync(topic);
    if (topic === 'camera' && key === view.id) editor.refresh(); // a mirroring tab changed this view
    if (topic === 'geometry' || topic === 'detections') updateReadout();
  }, () => {
    view.save();
    PM.publishDetections(mine);
  });
  requestAnimationFrame(tick);
})();
