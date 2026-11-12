// Page 2: projector output. Each mapping set has one homography from the
// true geometry onto the projector's pixels, defined by where that set's
// reference points A–D should appear on screen (its four draggable handles).
// A polygon is warped by the homography of the set it belongs to, so
// different sets can land on different surfaces.

(() => {
  const { WORLD, state } = PM;
  const canvas = document.getElementById('canvas');
  const setSelect = document.getElementById('set');

  let showGrid = true;
  let clean = false;   // true = output only: no handles, no controls
  let dragging = null; // { set, index }
  let size = { w: 1, h: 1 };

  const handlesPx = (set) => PM.quad('projector', set).map(([x, y]) => [x * size.w, y * size.h]);

  function render() {
    const { ctx, w, h } = PM.fitCanvas(canvas);
    size = { w, h };
    ctx.fillStyle = '#000';
    ctx.fillRect(0, 0, w, h);

    if (document.activeElement !== setSelect) PM.fillSetSelect(setSelect, state.active);
    for (const set of PM.sets()) renderSet(ctx, set, w, h);
    if (!clean) {
      // Active set last so its handles sit on top.
      const active = PM.activeSet();
      for (const set of [...PM.sets().filter((s) => s !== active), active]) PM.drawQuad(ctx, handlesPx(set), set);
    }
  }

  function renderSet(ctx, set, w, h) {
    // True geometry -> projector pixels, for this set
    const H = PM.solveHomography(set.refs, handlesPx(set));
    const map = (p) => PM.applyHomography(H, p);

    if (H && showGrid && set === PM.activeSet()) {
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
      PM.drawPolygons(ctx, map, { fillAlpha: 0.55, setId: set.id });
      for (const d of state.detections) {
        const p = d.setId === set.id && map([d.x, d.y]);
        if (p) PM.drawDetection(ctx, ...p);
      }
    } else if (set === PM.activeSet()) {
      PM.drawLabel(ctx, `${set.name}: reference points are degenerate — move a corner.`, w / 2, h / 2, '#ff6b6b');
    }
  }

  // ---- Corner dragging --------------------------------------------------

  canvas.addEventListener('pointerdown', (e) => {
    if (clean) return;
    dragging = PM.pickHandle(handlesPx, e.clientX, e.clientY, 18);
    if (!dragging) return;
    canvas.setPointerCapture(e.pointerId);
    PM.setActive(dragging.set.id); // grabbing a handle makes its set the active one
    render();
  });

  canvas.addEventListener('pointermove', (e) => {
    if (dragging) {
      PM.quad('projector', dragging.set)[dragging.index] = [e.clientX / size.w, e.clientY / size.h];
      PM.publish('projector');
      render();
    } else if (!clean) {
      canvas.style.cursor = PM.pickHandle(handlesPx, e.clientX, e.clientY, 18) ? 'grab' : 'default';
    }
  });

  canvas.addEventListener('pointerup', () => { dragging = null; });
  canvas.addEventListener('pointercancel', () => { dragging = null; });

  // ---- Controls ---------------------------------------------------------

  const actions = {
    fullscreen() {
      if (document.fullscreenElement) document.exitFullscreen();
      else document.documentElement.requestFullscreen();
    },
    grid() { showGrid = !showGrid; render(); },
    reset() { PM.resetQuad('projector', PM.activeSet()); render(); },
    hide() {
      clean = !clean;
      document.body.classList.toggle('clean', clean);
      render();
    },
  };

  for (const id of Object.keys(actions)) document.getElementById(id).onclick = actions[id];

  setSelect.onchange = () => { PM.setActive(setSelect.value); setSelect.blur(); render(); };

  window.addEventListener('keydown', (e) => {
    if (e.target === setSelect) return;
    const action = { f: 'fullscreen', g: 'grid', r: 'reset', h: 'hide' }[e.key.toLowerCase()];
    if (action) actions[action]();
  });

  PM.init(['projector'], render);
  window.addEventListener('resize', render);
  render();
})();
