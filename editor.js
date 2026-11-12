// Polygon drawing and editing, shared by all three pages.
//
// Polygons are always stored in true-geometry coordinates. Each page supplies
// the transformation between its own canvas and the true geometry for a given
// mapping set, so the same tools work in every view:
//
//   toWorld(set, x, y)  canvas pixels   -> true geometry (null if unmappable)
//   toScreen(set, p)    true geometry   -> canvas pixels (null if unmappable)
//
// On the geometry page these are a plain scale and offset. On the projector
// and camera pages they are the set's homography and its inverse, so a corner
// clicked in the projected image or on the video is stored where it really is.
//
// The editor also drags each view's A–D handles (Edit tool only):
//
//   handlesOf(set)                 the set's four handles in canvas pixels
//   moveHandle(set, index, x, y)   store a dragged handle and publish it
//
// Controls are picked up by id if the page has them: #tool-draw, #tool-edit,
// #color, #name, #poly-set, #delete, #hint, #list.

PM.createEditor = (opts) => {
  const {
    canvas, toScreen, toWorld, handlesOf, moveHandle,
    snap = (p) => p,            // optional adjustment of new/moved points
    render = () => {},          // redraw request (pages with a frame loop can omit it)
    enabled = () => true,       // false disables all input (projector "clean" mode)
    onRefresh = () => {},       // extra sidebar refresh for the page
    visible = () => true,       // (set) -> false if the set is hidden in this view
    intercept = () => false,    // (event, x, y) -> true if the page handles this press itself
    onEmptyPress = () => {},    // (event) Edit-tool press that hit nothing
    initialTool = 'edit',
  } = opts;
  const { state } = PM;
  const $ = (id) => document.getElementById(id);
  const ui = {
    draw: $('tool-draw'), edit: $('tool-edit'), color: $('color'), name: $('name'),
    polySet: $('poly-set'), del: $('delete'), hint: $('hint'), list: $('list'),
  };

  let tool = initialTool;
  let draft = [];          // corners of the polygon being drawn (true geometry)
  let draftSetId = null;   // the mapping set the draft is being drawn in
  let cursor = null;       // pointer position in true geometry, for the rubber band
  let selectedId = null;
  let drag = null;         // { kind: 'handle' | 'vertex' | 'poly', ... }
  let pickedColor = null;  // colour chosen for the next polygon, if any

  const polygons = () => state.geometry.polygons;
  // Next polygon's colour: the user's pick, else cycle the palette. Based on
  // the shared polygon count so pages don't all start on the same colour.
  const drawColor = () => pickedColor || PM.PALETTE[polygons().length % PM.PALETTE.length];
  const selected = () => polygons().find((p) => p.id === selectedId) || null;
  const setOf = (poly) => PM.sets().find((s) => s.id === poly.setId);
  const setById = (id) => PM.sets().find((s) => s.id === id);

  function changed() {
    PM.publish('geometry');
    refresh();
    render();
  }

  // ---- State changes ----------------------------------------------------

  function setTool(next) {
    tool = next;
    draft = [];
    refresh();
    render();
  }

  function select(id) {
    selectedId = id;
    const sel = selected();
    if (sel) PM.setActive(sel.setId); // work in the selected polygon's set
    refresh();
    render();
  }

  function activate(setId) {
    PM.setActive(setId);
    const sel = selected();
    if (sel && sel.setId !== setId) selectedId = null;
    refresh();
    render();
  }

  function finishDraft() {
    if (draft.length < 3) return;
    const poly = {
      id: PM.uid(),
      name: `Polygon ${polygons().length + 1}`,
      color: drawColor(),
      setId: draftSetId,
      points: draft,
    };
    polygons().push(poly);
    draft = [];
    selectedId = poly.id;
    pickedColor = null;
    changed();
    if (ui.name) { // let the user type a name straight away
      ui.name.focus();
      ui.name.select();
    }
  }

  function removePolygon(id) {
    state.geometry.polygons = polygons().filter((p) => p.id !== id);
    if (selectedId === id) selectedId = null;
    changed();
  }

  // Topmost polygon under a canvas point, testing each polygon in true
  // geometry through its own set's transformation.
  function polygonAt(x, y) {
    const worldBySet = {};
    for (const poly of [...polygons()].reverse()) {
      if (!visible(setOf(poly))) continue;
      if (!(poly.setId in worldBySet)) worldBySet[poly.setId] = toWorld(setOf(poly), x, y);
      const world = worldBySet[poly.setId];
      if (world && PM.pointInPolygon(world, poly.points)) return { poly, world };
    }
    return null;
  }

  // ---- Pointer ----------------------------------------------------------

  function pointerPos(e) {
    const r = canvas.getBoundingClientRect();
    return [e.clientX - r.left, e.clientY - r.top];
  }

  canvas.addEventListener('pointerdown', (e) => {
    if (!enabled()) return;
    const [x, y] = pointerPos(e);
    if (intercept(e, x, y) || e.button !== 0) return;
    if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur();

    if (tool === 'draw') {
      const set = draft.length ? setById(draftSetId) : PM.activeSet();
      if (!visible(set)) return; // nothing drawn here would be shown
      if (!draft.length) { selectedId = null; draftSetId = set.id; refresh(); }
      const pts = draft.map((p) => toScreen(set, p));
      if (draft.length >= 3 && PM.pick([pts[0]], x, y) === 0) { finishDraft(); return; }
      if (pts.length && PM.pick([pts[pts.length - 1]], x, y, 3) === 0) return; // 2nd click of a double-click
      const world = toWorld(set, x, y);
      if (world) draft.push(snap(world));
      render();
      return;
    }

    canvas.setPointerCapture(e.pointerId);
    const handle = PM.pickHandle(handlesOf, x, y);
    if (handle) {
      drag = { kind: 'handle', setId: handle.set.id, index: handle.index };
      activate(handle.set.id); // grabbing a handle makes its set the active one
      return;
    }

    const sel = selected();
    if (sel) {
      const v = PM.pick(sel.points.map((p) => toScreen(setOf(sel), p)), x, y, 9);
      if (v >= 0) { drag = { kind: 'vertex', index: v }; return; }
    }

    const hit = polygonAt(x, y);
    if (hit) {
      drag = { kind: 'poly', start: snap(hit.world), original: hit.poly.points.map((p) => [...p]) };
      select(hit.poly.id);
    } else {
      select(null);
      onEmptyPress(e);
    }
  });

  canvas.addEventListener('pointermove', (e) => {
    if (!enabled()) return;
    const [x, y] = pointerPos(e);

    if (drag && drag.kind === 'handle') {
      const set = setById(drag.setId);
      if (set) moveHandle(set, drag.index, x, y);
      render();
      return;
    }

    if (drag) {
      const sel = selected();
      const world = sel && toWorld(setOf(sel), x, y);
      if (!world) return;
      const p = snap(world);
      if (drag.kind === 'vertex') sel.points[drag.index] = p;
      else sel.points = drag.original.map(([px, py]) => [px + p[0] - drag.start[0], py + p[1] - drag.start[1]]);
      PM.publish('geometry'); // live update on the other pages while dragging
      render();
      return;
    }

    if (tool === 'draw') {
      const set = draft.length ? setById(draftSetId) : PM.activeSet();
      const world = toWorld(set, x, y);
      cursor = world && snap(world);
      if (draft.length) render();
    } else {
      canvas.style.cursor = PM.pickHandle(handlesOf, x, y) ? 'grab' : 'default';
    }
  });

  const endDrag = () => { drag = null; };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('dblclick', () => { if (tool === 'draw' && enabled()) finishDraft(); });
  // Keep the click from stealing focus back after a new polygon focuses the name box.
  canvas.addEventListener('mousedown', (e) => e.preventDefault());

  // ---- Keyboard ---------------------------------------------------------

  window.addEventListener('keydown', (e) => {
    const el = e.target;
    if (el.matches && el.matches('input[type="text"], select, textarea')) {
      if (el.matches('input') && (e.key === 'Enter' || e.key === 'Escape')) el.blur();
      return;
    }
    if (!enabled()) return;
    if (e.key === 'Enter') finishDraft();
    else if (e.key === 'Escape') { draft = []; render(); }
    else if (e.key === 'Backspace' && draft.length) { draft.pop(); render(); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedId) removePolygon(selectedId);
    else if (e.key === 'd') setTool('draw');
    else if (e.key === 'e') setTool('edit');
  });

  // ---- Controls ---------------------------------------------------------

  if (ui.draw) ui.draw.onclick = () => setTool('draw');
  if (ui.edit) ui.edit.onclick = () => setTool('edit');
  if (ui.del) ui.del.onclick = () => { if (selectedId) removePolygon(selectedId); };

  if (ui.name) ui.name.addEventListener('input', () => {
    const sel = selected();
    if (sel) { sel.name = ui.name.value; changed(); }
  });

  if (ui.color) ui.color.addEventListener('input', () => {
    const sel = selected();
    if (sel) { sel.color = ui.color.value; changed(); }
    else { pickedColor = ui.color.value; render(); }
  });

  if (ui.polySet) ui.polySet.addEventListener('change', () => {
    const sel = selected();
    if (!sel) return;
    sel.setId = ui.polySet.value;
    PM.setActive(sel.setId);
    ui.polySet.blur();
    changed();
  });

  function refresh() {
    // A draft belongs to one set; drop it if that set is no longer the active one.
    if (draft.length && draftSetId !== state.active) draft = [];
    // Nothing hidden stays selected.
    if (selected() && !visible(setOf(selected()))) selectedId = null;
    const sel = selected();

    if (ui.draw) ui.draw.classList.toggle('active', tool === 'draw');
    if (ui.edit) ui.edit.classList.toggle('active', tool === 'edit');
    if (tool === 'draw') canvas.style.cursor = 'crosshair';
    if (ui.hint) {
      ui.hint.textContent = !visible(PM.activeSet())
        ? `"${PM.activeSet().name}" is the active set but is hidden in this view. Tick it, or pick another set, to draw.`
        : tool === 'draw'
        ? 'Click to add corners. Click the first corner, double-click or press Enter to close. Backspace undoes a corner, Esc cancels.'
        : 'Click a polygon to select it, drag to move it, drag its corners to reshape it. Delete removes it. Drag A–D to place reference points.';
    }
    if (ui.name) {
      ui.name.disabled = !sel;
      if (document.activeElement !== ui.name) ui.name.value = sel ? sel.name : '';
    }
    if (ui.color) ui.color.value = sel ? sel.color : drawColor();
    if (ui.polySet && document.activeElement !== ui.polySet) {
      PM.fillSetSelect(ui.polySet, sel ? sel.setId : state.active);
      ui.polySet.disabled = !sel;
    }
    if (ui.del) ui.del.disabled = !sel;
    if (ui.list) refreshList();
    onRefresh();
  }

  function refreshList() {
    ui.list.innerHTML = '';
    if (!polygons().length) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'Nothing drawn yet.';
      ui.list.append(li);
    }
    for (const poly of polygons()) {
      const li = document.createElement('li');
      li.classList.toggle('selected', poly.id === selectedId);
      const swatch = document.createElement('span');
      swatch.className = 'swatch';
      swatch.style.background = poly.color;
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = poly.name || '(unnamed)';
      const set = setOf(poly);
      const setDot = document.createElement('span');
      setDot.className = 'swatch';
      setDot.title = set.name;
      setDot.style.cssText = `background:${set.color};border-radius:50%;width:8px;height:8px`;
      const del = document.createElement('button');
      del.textContent = '✕';
      del.title = 'Delete';
      del.onclick = (e) => { e.stopPropagation(); removePolygon(poly.id); };
      li.onclick = () => { setTool('edit'); select(poly.id); };
      li.append(swatch, name, setDot, del);
      ui.list.append(li);
    }
  }

  // ---- Drawing ----------------------------------------------------------

  // Corner handles of the selected polygon and the polygon in progress.
  // Call after the page has drawn its polygons.
  function drawOverlay(ctx) {
    const sel = selected();
    if (sel && tool === 'edit') {
      for (const p of sel.points) {
        const s = toScreen(setOf(sel), p);
        if (!s) continue;
        ctx.fillStyle = '#fff';
        ctx.fillRect(s[0] - 4, s[1] - 4, 8, 8);
        ctx.strokeStyle = '#000';
        ctx.lineWidth = 1;
        ctx.strokeRect(s[0] - 4, s[1] - 4, 8, 8);
      }
    }

    const set = draft.length && setById(draftSetId);
    if (!set) return;
    const pts = draft.map((p) => toScreen(set, p)).filter(Boolean);
    const tip = cursor && toScreen(set, cursor);
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    if (tip) ctx.lineTo(...tip);
    ctx.strokeStyle = drawColor();
    ctx.lineWidth = 2;
    ctx.stroke();
    pts.forEach(([x, y], i) => {
      ctx.beginPath();
      ctx.arc(x, y, i === 0 ? 7 : 4, 0, Math.PI * 2);
      ctx.fillStyle = i === 0 ? '#fff' : drawColor();
      ctx.fill();
    });
  }

  // Call when a message arrives from another page.
  function sync(topic) {
    const sel = selected();
    if (topic === 'active' && sel && sel.setId !== state.active) selectedId = null;
    if (topic === 'geometry' || topic === 'active') { refresh(); render(); }
  }

  refresh();

  return {
    get tool() { return tool; },
    get selectedId() { return selectedId; },
    get busy() { return !!drag || draft.length > 0; },
    // True if (x, y) is on a corner of the selected polygon.
    onVertex(x, y) {
      const sel = selected();
      return !!sel && tool === 'edit' && PM.pick(sel.points.map((p) => toScreen(setOf(sel), p)), x, y, 9) >= 0;
    },
    setTool, select, activate, changed, refresh, sync, drawOverlay,
    deselect() { selectedId = null; draft = []; },
  };
};
