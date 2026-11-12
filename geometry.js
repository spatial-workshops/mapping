// Page 1: the "true geometry" editor. Owns the polygons and the four
// reference points, and broadcasts them on every change.

(() => {
  const { WORLD, state } = PM;
  const GRID = 50;

  const canvas = document.getElementById('canvas');
  const nameInput = document.getElementById('name');
  const colorInput = document.getElementById('color');
  const snapInput = document.getElementById('snap');
  const listEl = document.getElementById('list');
  const hintEl = document.getElementById('hint');
  const detectedEl = document.getElementById('detected');

  let tool = 'draw';
  let draft = [];          // vertices of the polygon being drawn
  let cursor = null;       // last pointer position in world units
  let selectedId = null;
  let drag = null;         // { kind: 'ref' | 'vertex' | 'poly', ... }
  let drawColor = colorInput.value;
  let view = { s: 1, ox: 0, oy: 0 };

  const geo = () => state.geometry;
  const selected = () => geo().polygons.find((p) => p.id === selectedId) || null;
  const toScreen = ([x, y]) => [view.ox + x * view.s, view.oy + y * view.s];
  const toWorld = (x, y) => [(x - view.ox) / view.s, (y - view.oy) / view.s];
  const clamp = ([x, y]) => [Math.max(0, Math.min(WORLD.w, x)), Math.max(0, Math.min(WORLD.h, y))];
  const snap = (p) => clamp(snapInput.checked ? p.map((v) => Math.round(v / GRID) * GRID) : p.map(Math.round));

  function changed() {
    PM.publish('geometry');
    refreshUI();
    render();
  }

  // ---- Rendering --------------------------------------------------------

  function render() {
    const { ctx, w, h } = PM.fitCanvas(canvas);
    const margin = 30;
    view.s = Math.min((w - margin * 2) / WORLD.w, (h - margin * 2) / WORLD.h);
    view.ox = (w - WORLD.w * view.s) / 2;
    view.oy = (h - WORLD.h * view.s) / 2;

    ctx.clearRect(0, 0, w, h);

    // Sheet and grid
    const [x0, y0] = toScreen([0, 0]);
    ctx.fillStyle = '#0e1013';
    ctx.fillRect(x0, y0, WORLD.w * view.s, WORLD.h * view.s);
    ctx.beginPath();
    for (let x = 0; x <= WORLD.w; x += GRID) {
      ctx.moveTo(x0 + x * view.s, y0);
      ctx.lineTo(x0 + x * view.s, y0 + WORLD.h * view.s);
    }
    for (let y = 0; y <= WORLD.h; y += GRID) {
      ctx.moveTo(x0, y0 + y * view.s);
      ctx.lineTo(x0 + WORLD.w * view.s, y0 + y * view.s);
    }
    ctx.strokeStyle = '#1f232a';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.strokeStyle = '#3a414d';
    ctx.strokeRect(x0, y0, WORLD.w * view.s, WORLD.h * view.s);

    PM.drawPolygons(ctx, toScreen, { selectedId });

    // Vertex handles on the selected polygon
    const sel = selected();
    if (sel && tool === 'edit') {
      for (const p of sel.points) {
        const [x, y] = toScreen(p);
        ctx.fillStyle = '#fff';
        ctx.fillRect(x - 4, y - 4, 8, 8);
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1;
        ctx.strokeRect(x - 4, y - 4, 8, 8);
      }
    }

    // Polygon in progress
    if (draft.length) {
      const pts = draft.map(toScreen);
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      if (cursor) ctx.lineTo(...toScreen(cursor));
      ctx.strokeStyle = drawColor;
      ctx.lineWidth = 2;
      ctx.stroke();
      pts.forEach(([x, y], i) => {
        ctx.beginPath();
        ctx.arc(x, y, i === 0 ? 7 : 4, 0, Math.PI * 2);
        ctx.fillStyle = i === 0 ? '#fff' : drawColor;
        ctx.fill();
      });
    }

    // Reference points
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    geo().refs.map(toScreen).forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.strokeStyle = 'rgba(255,225,77,0.35)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);
    geo().refs.forEach((p, i) => PM.drawHandle(ctx, ...toScreen(p), PM.REF_LABELS[i]));

    for (const d of state.detections) PM.drawDetection(ctx, ...toScreen([d.x, d.y]));
  }

  function refreshUI() {
    document.getElementById('tool-draw').classList.toggle('active', tool === 'draw');
    document.getElementById('tool-edit').classList.toggle('active', tool === 'edit');
    canvas.style.cursor = tool === 'draw' ? 'crosshair' : 'default';
    hintEl.textContent = tool === 'draw'
      ? 'Click to add corners. Click the first corner, double-click or press Enter to close. Backspace undoes a corner, Esc cancels.'
      : 'Click a polygon to select it, drag to move it, drag its corners to reshape it. Delete removes it.';

    const sel = selected();
    nameInput.disabled = !sel;
    if (document.activeElement !== nameInput) nameInput.value = sel ? sel.name : '';
    colorInput.value = sel ? sel.color : drawColor;

    listEl.innerHTML = '';
    if (!geo().polygons.length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'Nothing drawn yet.';
      listEl.append(li);
    }
    for (const poly of geo().polygons) {
      const li = document.createElement('li');
      li.classList.toggle('selected', poly.id === selectedId);
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = poly.color;
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = poly.name || '(unnamed)';
      const del = document.createElement('button');
      del.textContent = '✕';
      del.title = 'Delete';
      del.onclick = (e) => { e.stopPropagation(); removePolygon(poly.id); };
      li.onclick = () => { setTool('edit'); select(poly.id); };
      li.append(swatch, name, del);
      listEl.append(li);
    }
    refreshDetected();
  }

  function refreshDetected() {
    if (!state.detections.length) { detectedEl.textContent = '—'; return; }
    detectedEl.textContent = state.detections.map((d) => {
      const inside = geo().polygons.filter((p) => PM.pointInPolygon([d.x, d.y], p.points)).map((p) => p.name || '(unnamed)');
      return `${d.source}: (${Math.round(d.x)}, ${Math.round(d.y)})` + (inside.length ? `\n  in ${inside.join(', ')}` : '');
    }).join('\n');
  }

  // ---- Editing ----------------------------------------------------------

  function setTool(next) {
    tool = next;
    draft = [];
    refreshUI();
    render();
  }

  function select(id) {
    selectedId = id;
    refreshUI();
    render();
  }

  function finishDraft() {
    if (draft.length < 3) return;
    const n = geo().polygons.length + 1;
    const poly = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), name: `Polygon ${n}`, color: drawColor, points: draft };
    geo().polygons.push(poly);
    draft = [];
    selectedId = poly.id;
    drawColor = PM.PALETTE[(PM.PALETTE.indexOf(drawColor) + 1) % PM.PALETTE.length];
    changed();
    // Let the user type a name straight away.
    nameInput.focus();
    nameInput.select();
  }

  function removePolygon(id) {
    geo().polygons = geo().polygons.filter((p) => p.id !== id);
    if (selectedId === id) selectedId = null;
    changed();
  }

  function pointerPos(e) {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    nameInput.blur();
    const [sx, sy] = pointerPos(e);
    const world = toWorld(sx, sy);

    if (tool === 'draw') {
      if (!draft.length) { selectedId = null; refreshUI(); }
      if (draft.length >= 3 && PM.pick([toScreen(draft[0])], sx, sy) === 0) { finishDraft(); return; }
      const p = snap(world);
      const last = draft[draft.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) draft.push(p); // ignore the 2nd click of a double-click
      render();
      return;
    }

    canvas.setPointerCapture(e.pointerId);
    const ref = PM.pick(geo().refs.map(toScreen), sx, sy);
    if (ref >= 0) { drag = { kind: 'ref', index: ref }; return; }

    const sel = selected();
    if (sel) {
      const v = PM.pick(sel.points.map(toScreen), sx, sy, 9);
      if (v >= 0) { drag = { kind: 'vertex', index: v }; return; }
    }

    const hit = [...geo().polygons].reverse().find((p) => PM.pointInPolygon(world, p.points));
    if (hit) {
      drag = { kind: 'poly', start: snap(world), original: hit.points.map((p) => [...p]) };
      select(hit.id);
    } else {
      select(null);
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    const world = snap(toWorld(...pointerPos(e)));
    cursor = world;
    if (drag) {
      if (drag.kind === 'ref') geo().refs[drag.index] = world;
      if (drag.kind === 'vertex') selected().points[drag.index] = world;
      if (drag.kind === 'poly') {
        const dx = world[0] - drag.start[0], dy = world[1] - drag.start[1];
        selected().points = drag.original.map(([x, y]) => [x + dx, y + dy]);
      }
      PM.publish('geometry'); // live update on the other pages while dragging
    }
    if (drag || draft.length) render();
  });

  // Keep the click from stealing focus back after a new polygon focuses the name box.
  canvas.addEventListener('mousedown', (e) => e.preventDefault());
  canvas.addEventListener('pointerup', () => { drag = null; });
  canvas.addEventListener('pointercancel', () => { drag = null; });
  canvas.addEventListener('dblclick', () => { if (tool === 'draw') finishDraft(); });

  window.addEventListener('keydown', (e) => {
    if (e.target === nameInput) {
      if (e.key === 'Enter' || e.key === 'Escape') nameInput.blur();
      return;
    }
    if (e.key === 'Enter') finishDraft();
    else if (e.key === 'Escape') { draft = []; render(); }
    else if (e.key === 'Backspace' && draft.length) { draft.pop(); render(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) removePolygon(selectedId);
    else if (e.key === 'd') setTool('draw');
    else if (e.key === 'e') setTool('edit');
  });

  // ---- Sidebar ----------------------------------------------------------

  document.getElementById('tool-draw').onclick = () => setTool('draw');
  document.getElementById('tool-edit').onclick = () => setTool('edit');

  nameInput.addEventListener('input', () => {
    const sel = selected();
    if (sel) { sel.name = nameInput.value; changed(); }
  });

  colorInput.addEventListener('input', () => {
    const sel = selected();
    if (sel) { sel.color = colorInput.value; changed(); }
    else { drawColor = colorInput.value; render(); }
  });

  document.getElementById('reset-refs').onclick = () => {
    geo().refs = [[150, 100], [1050, 100], [1050, 700], [150, 700]];
    changed();
  };

  document.getElementById('clear').onclick = () => {
    if (!geo().polygons.length || !confirm('Delete every polygon?')) return;
    geo().polygons = [];
    selectedId = null;
    draft = [];
    changed();
  };

  // ---- Boot -------------------------------------------------------------

  PM.init(['geometry'], (topic) => {
    if (topic === 'detections') { refreshDetected(); render(); }
    if (topic === 'geometry') { refreshUI(); render(); } // another geometry tab edited it
  });

  new ResizeObserver(render).observe(canvas);
  refreshUI();
  render();
})();
