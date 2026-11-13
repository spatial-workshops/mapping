// Page 1: the "true geometry" view. Polygons and mapping sets are stored in
// this page's coordinate system, so its transformation is just the scale and
// offset of the current pan and zoom. Drawing and editing come from the
// shared editor (editor.js); this page adds the mapping-set list, pan/zoom,
// and dragging of whole mapping sets.

(() => {
  const { WORLD, state } = PM;
  const GRID = 50;

  const canvas = document.getElementById('canvas');
  const snapInput = document.getElementById('snap');
  const setsEl = document.getElementById('sets');
  const setNameInput = document.getElementById('set-name');
  const detectedEl = document.getElementById('detected');

  // The view: `zoom` is relative to "sheet fits the window"; (cx, cy) is the
  // true-geometry point at the centre of the canvas. s/ox/oy are derived.
  let view = { zoom: 1, cx: WORLD.w / 2, cy: WORLD.h / 2, s: 1, ox: 0, oy: 0 };
  let action = null;       // this page's own drags: { kind: 'pan' | 'set', ... }
  let spaceHeld = false;

  const geo = () => state.geometry;
  const toScreen = ([x, y]) => [view.ox + x * view.s, view.oy + y * view.s];
  const toWorld = (x, y) => [(x - view.ox) / view.s, (y - view.oy) / view.s];
  const snap = (p) => (snapInput.checked ? p.map((v) => Math.round(v / GRID) * GRID) : p.map(Math.round));
  const refsPx = (set) => set.refs.map(toScreen);

  const editor = PM.createEditor({
    canvas,
    toScreen: (set, p) => toScreen(p),
    toWorld: (set, x, y) => toWorld(x, y),
    handlesOf: refsPx,
    moveHandle(set, index, x, y) {
      set.refs[index] = snap(toWorld(x, y));
      PM.publish('geometry');
    },
    snap,
    render,
    onRefresh: refreshSets,
    initialTool: 'draw',
    intercept: startAction,
    onEmptyPress: startPan,
  });

  // ---- Rendering --------------------------------------------------------

  function updateView() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    const margin = 30;
    const fit = Math.max(0.01, Math.min((w - margin * 2) / WORLD.w, (h - margin * 2) / WORLD.h));
    view.s = fit * view.zoom;
    view.ox = w / 2 - view.cx * view.s;
    view.oy = h / 2 - view.cy * view.s;
  }

  function render() {
    const { ctx, w, h } = PM.fitCanvas(canvas);
    updateView();
    ctx.clearRect(0, 0, w, h);

    // Sheet (the nominal drawing area) and a grid over everything visible
    const [x0, y0] = toScreen([0, 0]);
    ctx.fillStyle = '#0e1013';
    ctx.fillRect(x0, y0, WORLD.w * view.s, WORLD.h * view.s);

    let step = GRID;
    while (step * view.s < 12) step *= 2; // keep lines readable when zoomed out
    const [wx0, wy0] = toWorld(0, 0);
    const [wx1, wy1] = toWorld(w, h);
    ctx.beginPath();
    for (let x = Math.ceil(wx0 / step) * step; x <= wx1; x += step) {
      const sx = view.ox + x * view.s;
      ctx.moveTo(sx, 0);
      ctx.lineTo(sx, h);
    }
    for (let y = Math.ceil(wy0 / step) * step; y <= wy1; y += step) {
      const sy = view.oy + y * view.s;
      ctx.moveTo(0, sy);
      ctx.lineTo(w, sy);
    }
    ctx.strokeStyle = '#1f232a';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.strokeStyle = '#3a414d';
    ctx.strokeRect(x0, y0, WORLD.w * view.s, WORLD.h * view.s);

    PM.drawPolygons(ctx, toScreen, { selectedId: editor.selectedId });
    editor.drawOverlay(ctx);

    // Reference points of every mapping set, active set on top
    const active = PM.activeSet();
    for (const set of [...PM.sets().filter((s) => s !== active), active]) PM.drawQuad(ctx, refsPx(set), set);

    for (const d of state.detections) PM.drawDetection(ctx, ...toScreen([d.x, d.y]));
  }

  // ---- Pan and zoom -----------------------------------------------------

  // Zoom by `factor`, keeping the true-geometry point under (x, y) in place.
  function zoomAt(factor, x = canvas.clientWidth / 2, y = canvas.clientHeight / 2) {
    const zoom = Math.max(0.1, Math.min(30, view.zoom * factor));
    const [wx, wy] = toWorld(x, y);
    const k = view.s * (zoom / view.zoom); // new scale
    view.zoom = zoom;
    view.cx = wx - (x - canvas.clientWidth / 2) / k;
    view.cy = wy - (y - canvas.clientHeight / 2) / k;
    render();
  }

  function fitView() {
    view.zoom = 1;
    view.cx = WORLD.w / 2;
    view.cy = WORLD.h / 2;
    render();
  }

  function pointerPos(e) {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  function startPan(e) {
    const [x, y] = pointerPos(e);
    action = { kind: 'pan', x, y, cx: view.cx, cy: view.cy };
    canvas.setPointerCapture(e.pointerId);
    canvas.style.cursor = 'grabbing';
  }

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    // Pinch gestures arrive as ctrl+wheel with small deltas.
    zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), ...pointerPos(e));
  }, { passive: false });

  document.getElementById('zoom-in').onclick = () => zoomAt(1.25);
  document.getElementById('zoom-out').onclick = () => zoomAt(0.8);
  document.getElementById('zoom-fit').onclick = fitView;

  const typing = (e) => e.target.matches && e.target.matches('input[type="text"], select, textarea');

  window.addEventListener('keydown', (e) => {
    if (typing(e)) return;
    if (e.key === ' ') {
      e.preventDefault(); // don't scroll, or press a focused button
      spaceHeld = true;
      if (!action) canvas.style.cursor = 'grab';
    } else if (e.key === '+' || e.key === '=') zoomAt(1.25);
    else if (e.key === '-') zoomAt(0.8);
    else if (e.key === '0') fitView();
  });

  window.addEventListener('keyup', (e) => {
    if (e.key !== ' ') return;
    if (!typing(e)) e.preventDefault();
    spaceHeld = false;
    if (!action) canvas.style.cursor = editor.tool === 'draw' ? 'crosshair' : 'default';
  });

  // ---- Dragging a whole mapping set ---------------------------------------
  // Grab a set by its dashed outline (Edit tool). Its reference points and
  // its polygons move together, so what the projector and camera show does
  // not change: only where the set sits in the true geometry.

  function distToSegment([px, py], [ax, ay], [bx, by]) {
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
    return Math.hypot(px - ax - t * dx, py - ay - t * dy);
  }

  function setOutlineAt(x, y) {
    if (editor.tool !== 'edit' || PM.pickHandle(refsPx, x, y) || editor.onVertex(x, y)) return null;
    const active = PM.activeSet();
    for (const set of [active, ...PM.sets().filter((s) => s !== active)]) {
      const pts = refsPx(set);
      if (pts.some((p, i) => distToSegment([x, y], p, pts[(i + 1) % 4]) <= 6)) return set;
    }
    return null;
  }

  // Called by the editor before it handles a press; true means "mine".
  function startAction(e, x, y) {
    if (e.button === 1 || (e.button === 0 && spaceHeld)) {
      e.preventDefault();
      startPan(e);
      return true;
    }
    const set = e.button === 0 && setOutlineAt(x, y);
    if (!set) return false;
    editor.activate(set.id);
    action = {
      kind: 'set',
      setId: set.id,
      start: snap(toWorld(x, y)),
      refs: set.refs.map((p) => [...p]),
      polygons: geo().polygons.filter((p) => p.setId === set.id).map((p) => ({ id: p.id, points: p.points.map((q) => [...q]) })),
    };
    canvas.setPointerCapture(e.pointerId);
    return true;
  }

  canvas.addEventListener('pointermove', (e) => {
    const [x, y] = pointerPos(e);
    if (!action) {
      if (spaceHeld) canvas.style.cursor = 'grab';
      else if (setOutlineAt(x, y)) canvas.style.cursor = 'move';
      return;
    }
    canvas.style.cursor = action.kind === 'pan' ? 'grabbing' : 'move';
    if (action.kind === 'pan') {
      view.cx = action.cx - (x - action.x) / view.s;
      view.cy = action.cy - (y - action.y) / view.s;
    } else {
      const set = PM.sets().find((s) => s.id === action.setId);
      if (!set) return;
      const now = snap(toWorld(x, y));
      const move = ([px, py]) => [px + now[0] - action.start[0], py + now[1] - action.start[1]];
      set.refs = action.refs.map(move);
      for (const saved of action.polygons) {
        const poly = geo().polygons.find((p) => p.id === saved.id);
        if (poly) poly.points = saved.points.map(move);
      }
      PM.publish('geometry');
    }
    render();
  });

  const endAction = () => {
    if (!action) return;
    action = null;
    canvas.style.cursor = spaceHeld ? 'grab' : editor.tool === 'draw' ? 'crosshair' : 'default';
  };
  canvas.addEventListener('pointerup', endAction);
  canvas.addEventListener('pointercancel', endAction);

  // ---- Mapping sets -----------------------------------------------------

  function refreshSets() {
    const active = PM.activeSet();
    if (document.activeElement !== setNameInput) setNameInput.value = active.name;
    setsEl.innerHTML = '';
    for (const set of PM.sets()) {
      const li = document.createElement('li');
      li.classList.toggle('selected', set === active);
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.cssText = `background:${set.color};border-radius:50%`;
      const name = document.createElement('span');
      name.className = 'name';
      const count = geo().polygons.filter((p) => p.setId === set.id).length;
      name.textContent = `${set.name} (${count})`;
      li.append(swatch, name);
      if (PM.sets().length > 1) {
        const del = document.createElement('button');
        del.textContent = '✕';
        del.title = 'Delete set';
        del.onclick = (e) => { e.stopPropagation(); removeSet(set); };
        li.append(del);
      }
      li.onclick = () => editor.activate(set.id);
      setsEl.append(li);
    }
    detectedEl.textContent = PM.describeDetections();
  }

  function removeSet(set) {
    const others = PM.sets().filter((s) => s !== set);
    const mine = geo().polygons.filter((p) => p.setId === set.id);
    if (mine.length && !confirm(`Delete "${set.name}"? Its ${mine.length} polygon(s) will move to "${others[0].name}".`)) return;
    mine.forEach((p) => { p.setId = others[0].id; });
    geo().sets = others;
    if (state.active === set.id) PM.setActive(others[0].id);
    editor.changed();
  }

  setNameInput.addEventListener('input', () => {
    PM.activeSet().name = setNameInput.value;
    editor.changed();
  });

  document.getElementById('add-set').onclick = () => {
    const set = PM.addSet();
    PM.publish('geometry');
    editor.setTool('edit'); // so the new A–D can be dragged into place straight away
    editor.activate(set.id);
  };

  document.getElementById('reset-refs').onclick = () => {
    PM.activeSet().refs = PM.defaultRefs(PM.sets().indexOf(PM.activeSet()));
    editor.changed();
  };

  document.getElementById('clear').onclick = () => {
    if (!geo().polygons.length || !confirm('Delete every polygon?')) return;
    geo().polygons = [];
    editor.deselect();
    editor.changed();
  };

  // ---- Boot -------------------------------------------------------------

  PM.init((topic) => {
    editor.sync(topic);
    if (topic === 'detections') { detectedEl.textContent = PM.describeDetections(); render(); }
  }, () => {
    PM.publish('geometry');
    PM.publish('active');
  });

  new ResizeObserver(render).observe(canvas);
  render();
})();
