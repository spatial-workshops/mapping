// Page 2: projector output. One homography maps the true geometry onto the
// projector's pixels. It is defined by where the four reference points A–D
// (true geometry) should appear on screen, set by dragging the four handles.

(() => {
  const { WORLD, state } = PM;
  const canvas = document.getElementById('canvas');

  let showGrid = true;
  let clean = false;   // true = output only: no handles, no controls
  let dragging = -1;
  let size = { w: 1, h: 1 };

  const handlesPx = () => state.projector.map(([x, y]) => [x * size.w, y * size.h]);

  function render() {
    const { ctx, w, h } = PM.fitCanvas(canvas);
    size = { w, h };
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);

    // True geometry -> projector pixels
    const H = PM.solveHomography(state.geometry.refs, handlesPx());
    const map = (p) => PM.applyHomography(H, p);

    if (H && showGrid) {
      ctx.beginPath();
      const line = (a, b) => {
        const p = map(a), q = map(b);
        if (p && q) { ctx.moveTo(...p); ctx.lineTo(...q); }
      };
      for (let x = 0; x <= WORLD.w; x += 100) line([x, 0], [x, WORLD.h]);
      for (let y = 0; y <= WORLD.h; y += 100) line([0, y], [WORLD.w, y]);
      ctx.strokeStyle = 'rgba(255,255,255,0.22)';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    if (H) {
      PM.drawPolygons(ctx, map, { fillAlpha: 0.55 });
      for (const d of state.detections) {
        const p = map([d.x, d.y]);
        if (p) PM.drawDetection(ctx, ...p);
      }
    } else {
      PM.drawLabel(ctx, 'Reference points are degenerate — move a corner.', w / 2, h / 2, '#ff6b6b');
    }

    if (!clean) handlesPx().forEach(([x, y], i) => PM.drawHandle(ctx, x, y, PM.REF_LABELS[i]));
  }

  // ---- Corner dragging --------------------------------------------------

  canvas.addEventListener('pointerdown', (e) => {
    if (clean) return;
    dragging = PM.pick(handlesPx(), e.clientX, e.clientY, 18);
    if (dragging >= 0) canvas.setPointerCapture(e.pointerId);
  });

  canvas.addEventListener('pointermove', (e) => {
    if (dragging >= 0) {
      state.projector[dragging] = [e.clientX / size.w, e.clientY / size.h];
      PM.publish('projector');
      render();
    } else if (!clean) {
      canvas.style.cursor = PM.pick(handlesPx(), e.clientX, e.clientY, 18) >= 0 ? 'grab' : 'default';
    }
  });

  canvas.addEventListener('pointerup', () => { dragging = -1; });
  canvas.addEventListener('pointercancel', () => { dragging = -1; });

  // ---- Controls ---------------------------------------------------------

  const actions = {
    fullscreen() {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen();
    },
    grid() { showGrid = !showGrid; render(); },
    reset() { PM.reset('projector'); render(); },
    hide() {
      clean = !clean;
      document.body.classList.toggle('clean', clean);
      render();
    },
  };

  for (const id of Object.keys(actions)) document.getElementById(id).onclick = actions[id];

  window.addEventListener('keydown', (e) => {
    const action = { f: 'fullscreen', g: 'grid', r: 'reset', h: 'hide' }[e.key.toLowerCase()];
    if (action) actions[action]();
  });

  PM.init(['projector'], render);
  window.addEventListener('resize', render);
  render();
})();
