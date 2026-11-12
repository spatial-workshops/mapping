// Page 1: the "true geometry" view. Polygons and mapping sets are stored in
// this page's coordinate system, so its transformation is just the scale and
// offset that fit the drawing sheet into the window. Drawing and editing come
// from the shared editor (editor.js); this page adds the mapping-set list.

(() => {
  const { WORLD, state } = PM;
  const GRID = 50;

  const canvas = document.getElementById('canvas');
  const snapInput = document.getElementById('snap');
  const setsEl = document.getElementById('sets');
  const setNameInput = document.getElementById('set-name');
  const detectedEl = document.getElementById('detected');

  let view = { s: 1, ox: 0, oy: 0 };

  const geo = () => state.geometry;
  const toScreen = ([x, y]) => [view.ox + x * view.s, view.oy + y * view.s];
  const toWorld = (x, y) => [(x - view.ox) / view.s, (y - view.oy) / view.s];
  const clamp = ([x, y]) => [Math.max(0, Math.min(WORLD.w, x)), Math.max(0, Math.min(WORLD.h, y))];
  const snap = (p) => clamp(snapInput.checked ? p.map((v) => Math.round(v / GRID) * GRID) : p.map(Math.round));
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
  });

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

    PM.drawPolygons(ctx, toScreen, { selectedId: editor.selectedId });
    editor.drawOverlay(ctx);

    // Reference points of every mapping set, active set on top
    const active = PM.activeSet();
    for (const set of [...PM.sets().filter((s) => s !== active), active]) PM.drawQuad(ctx, refsPx(set), set);

    for (const d of state.detections) PM.drawDetection(ctx, ...toScreen([d.x, d.y]));
  }

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

  PM.init(['geometry', 'active'], (topic) => {
    editor.sync(topic);
    if (topic === 'detections') { detectedEl.textContent = PM.describeDetections(); render(); }
  });

  new ResizeObserver(render).observe(canvas);
  render();
})();
