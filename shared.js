// Shared state, messaging and math for the three projection-mapping pages.
// Loaded as a classic script; everything hangs off the global `PM`.
//
// A "mapping set" is one surface: four reference points A–D with three
// representations (true geometry, projector, camera) and therefore two
// homographies (true geometry -> projector, true geometry <-> camera).
// Every polygon belongs to one mapping set.
//
// The projector and camera pages are "views". Any number of each can be
// open: a view is named by the `?view=` number in its URL (default 1) and has
// its own handles and its own choice of visible sets, so two projector tabs
// with different numbers are two independent projectors. Tabs opened on the
// same view number mirror each other.
//
// Messages on the BroadcastChannel are { topic, key?, data }:
//   geometry            { polygons, sets }; editable from every page. A set's
//                       `refs` are its A–D in true-geometry units
//   active              id of the set being edited, shared by all pages
//   projector, key=view { quads: { setId: [[x,y] x4] }, hidden: { setId: true } }
//                       one projector view; quads normalised to the window
//   camera,    key=view the same for one camera view; quads normalised to the
//                       video frame
//   detections, key=tab [{ x, y, source, setId, view }] in true-geometry
//                       coordinates, from one camera tab
//   hello               a page just opened; the others re-broadcast their own state

const PM = (() => {
  const WORLD = { w: 1200, h: 800 }; // extent of the "true geometry" drawing space
  const REF_LABELS = ['A', 'B', 'C', 'D'];
  const SET_COLORS = ['#ffe14d', '#4dd8ff', '#ff8cf0', '#9dff6b', '#ffa04d', '#b8a6ff'];
  const PALETTE = ['#ff5a5f', '#ffb400', '#00c2a8', '#3d9bff', '#b56bff', '#ff7ac6', '#8bd450'];

  // Staggered starting positions so a new set's handles don't hide another's.
  const defaultRefs = (i) => {
    const o = 40 * (i % 5);
    return [[150 + o, 100 + o], [1050 - o, 100 + o], [1050 - o, 700 - o], [150 + o, 700 - o]];
  };
  const defaultQuad = (i) => {
    const a = 0.15 + 0.05 * (i % 4);
    return [[a, a], [1 - a, a], [1 - a, 1 - a], [a, 1 - a]];
  };

  const PERSISTED = ['geometry', 'active'];
  const VIEW_TOPICS = ['projector', 'camera'];
  const state = {
    geometry: {
      polygons: [], // { id, name, color, setId, points: [[x,y], ...] }
      sets: [],     // { id, name, color, refs: [[x,y] x4] }
    },
    active: null,
    projector: {},  // view id -> { quads, hidden }
    camera: {},     // view id -> { quads, hidden }
    detections: [], // every camera tab's detections, flattened (read-only)
  };
  const detectionsByTab = {};
  const listeners = [];
  let onHello = () => {};

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
  const tabId = uid();

  const read = (key) => {
    try { return JSON.parse(localStorage.getItem(key)); } catch (err) { return null; }
  };
  const write = (key, value) => {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch (err) { /* storage unavailable */ }
  };

  for (const topic of PERSISTED) {
    const saved = read('pm:' + topic);
    if (saved) state[topic] = saved;
  }

  // Keep the state self-consistent (and upgrade data saved before mapping
  // sets existed, when there was a single set of reference points).
  function normalise() {
    const g = state.geometry;
    if (!g.sets || !g.sets.length) {
      g.sets = [{ id: 'set1', name: 'Set 1', color: SET_COLORS[0], refs: g.refs || defaultRefs(0) }];
      delete g.refs;
    }
    const first = g.sets[0].id;
    for (const poly of g.polygons) if (!g.sets.some((s) => s.id === poly.setId)) poly.setId = first;
    if (!g.sets.some((s) => s.id === state.active)) state.active = first;
  }
  normalise();

  // Each view is saved under its own key so tabs never overwrite each other.
  for (const topic of VIEW_TOPICS) {
    const prefix = `pm:${topic}:`;
    try {
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key.startsWith(prefix)) state[topic][key.slice(prefix.length)] = read(key) || {};
      }
      // Upgrade data saved when there was only one projector and one camera.
      const legacy = read('pm:' + topic);
      if (legacy) {
        const quads = Array.isArray(legacy) ? { [state.geometry.sets[0].id]: legacy } : legacy;
        if (!state[topic]['1']) {
          state[topic]['1'] = { quads, hidden: {} };
          write(prefix + '1', state[topic]['1']);
        }
        localStorage.removeItem('pm:' + topic);
      }
    } catch (err) { /* storage unavailable */ }
  }

  const sets = () => state.geometry.sets;
  const activeSet = () => sets().find((s) => s.id === state.active) || sets()[0];

  function setActive(id) {
    if (state.active === id) return;
    state.active = id;
    publish('active');
  }

  function addSet() {
    const n = sets().length;
    let k = n + 1;
    while (sets().some((s) => s.name === `Set ${k}`)) k++;
    const set = { id: uid(), name: `Set ${k}`, color: SET_COLORS[n % SET_COLORS.length], refs: defaultRefs(n) };
    sets().push(set);
    return set;
  }

  const channel = new BroadcastChannel('projection-mapping');

  channel.onmessage = (e) => {
    const { topic, key, data } = e.data || {};
    if (topic === 'hello') { onHello(); return; }
    if (topic === 'detections') {
      setTabDetections(key, data);
    } else if (VIEW_TOPICS.includes(topic)) {
      state[topic][key] = data;
    } else if (PERSISTED.includes(topic)) {
      state[topic] = data;
      normalise();
    } else {
      return;
    }
    listeners.forEach((fn) => fn(topic, key));
  };

  // Call once per page. `onChange(topic, key)` runs when another tab changes
  // something; `rebroadcast` should re-publish what this page is showing, for
  // the benefit of a tab that has just opened.
  function init(onChange, rebroadcast) {
    if (onChange) listeners.push(onChange);
    if (rebroadcast) onHello = rebroadcast;
    channel.postMessage({ topic: 'hello' });
  }

  // Save and broadcast 'geometry' or 'active' after mutating PM.state.
  function publish(topic) {
    write('pm:' + topic, state[topic]);
    channel.postMessage({ topic, data: state[topic] });
  }

  // ---- Views (one projector or one camera) ---------------------------------

  // The view this page shows, from `?view=` in the URL. Its data is looked up
  // on every call because a mirroring tab may replace it at any time.
  function openView(topic) {
    const id = new URLSearchParams(location.search).get('view') || '1';
    const data = () => {
      const v = state[topic][id] || (state[topic][id] = {});
      if (!v.quads) v.quads = {};
      if (!v.hidden) v.hidden = {};
      return v;
    };
    const save = () => {
      write(`pm:${topic}:${id}`, data());
      channel.postMessage({ topic, key: id, data: data() });
    };
    const ids = () => [...new Set([...Object.keys(state[topic]), id])].sort((a, b) => a - b || a.localeCompare(b));
    const view = {
      id, topic, data, save, ids,
      // A set's four handles in this view, normalised 0..1.
      quad(set) {
        const quads = data().quads;
        return quads[set.id] || (quads[set.id] = defaultQuad(sets().indexOf(set)));
      },
      resetQuad(set) {
        data().quads[set.id] = defaultQuad(sets().indexOf(set));
        save();
      },
      visible: (set) => !data().hidden[set.id],
      setVisible(set, on) {
        if (on) delete data().hidden[set.id];
        else data().hidden[set.id] = true;
        save();
      },
      visibleSets: () => sets().filter(view.visible),
      nextId: () => String(Math.max(0, ...ids().map(Number).filter(Number.isFinite)) + 1),
    };
    save(); // so other tabs list this view
    return view;
  }

  // Checkbox list of mapping sets for a view: the checkbox shows or hides the
  // set in that view, clicking the name makes it the active set.
  function renderSetToggles(listEl, view, { onToggle, onActivate }) {
    listEl.innerHTML = '';
    for (const set of sets()) {
      const li = document.createElement('li');
      li.classList.toggle('selected', set === activeSet());
      li.title = 'Click to make this the active set';
      const box = document.createElement('input');
      box.type = 'checkbox';
      box.checked = view.visible(set);
      box.title = 'Show in this view';
      box.onclick = (e) => e.stopPropagation();
      box.onchange = () => { view.setVisible(set, box.checked); onToggle(set); };
      const dot = document.createElement('span');
      dot.className = 'swatch';
      dot.style.cssText = `background:${set.color};border-radius:50%`;
      const name = document.createElement('span');
      name.className = 'name';
      name.textContent = set.name;
      li.onclick = () => onActivate(set);
      li.append(box, dot, name);
      listEl.append(li);
    }
  }

  // "Projector 1 / Projector 2 / ..." switcher plus an "open another" button.
  function bindViewControls(view, label, select, newButton) {
    const fill = () => {
      select.innerHTML = '';
      for (const id of view.ids()) select.add(new Option(`${label} ${id}`, id));
      select.value = view.id;
    };
    fill();
    document.title = `${label} ${view.id} · Projection Mapping`;
    select.onfocus = fill;
    select.onchange = () => { location.search = '?view=' + encodeURIComponent(select.value); };
    newButton.onclick = () => window.open(`${location.pathname}?view=${view.nextId()}`, '_blank');
    return fill;
  }

  // ---- Detections ---------------------------------------------------------

  function setTabDetections(tab, list) {
    if (list && list.length) detectionsByTab[tab] = list;
    else delete detectionsByTab[tab];
    state.detections = Object.values(detectionsByTab).flat();
  }

  // Replace this tab's detections (other camera tabs keep theirs).
  function publishDetections(list) {
    setTabDetections(tabId, list);
    channel.postMessage({ topic: 'detections', key: tabId, data: list });
  }

  // ---- Homography -------------------------------------------------------

  // Solve for the 3x3 matrix H (row-major, 9 numbers) that maps each src[i]
  // to dst[i] for four point pairs. Returns null if the points are degenerate.
  function solveHomography(src, dst) {
    const A = [];
    for (let i = 0; i < 4; i++) {
      const [x, y] = src[i];
      const [u, v] = dst[i];
      A.push([x, y, 1, 0, 0, 0, -u * x, -u * y, u]);
      A.push([0, 0, 0, x, y, 1, -v * x, -v * y, v]);
    }
    // Gaussian elimination with partial pivoting on the 8x9 augmented matrix.
    for (let col = 0; col < 8; col++) {
      let pivot = col;
      for (let row = col + 1; row < 8; row++) {
        if (Math.abs(A[row][col]) > Math.abs(A[pivot][col])) pivot = row;
      }
      if (Math.abs(A[pivot][col]) < 1e-10) return null;
      [A[col], A[pivot]] = [A[pivot], A[col]];
      for (let row = 0; row < 8; row++) {
        if (row === col) continue;
        const f = A[row][col] / A[col][col];
        for (let k = col; k < 9; k++) A[row][k] -= f * A[col][k];
      }
    }
    const H = A.map((row, i) => row[8] / row[i]);
    H.push(1);
    // Keep w positive on the source points so "behind the plane" is w <= 0.
    const w = H[6] * src[0][0] + H[7] * src[0][1] + H[8];
    return w < 0 ? H.map((v) => -v) : H;
  }

  function invertHomography(H) {
    if (!H) return null;
    const [a, b, c, d, e, f, g, h, i] = H;
    const A = e * i - f * h, B = f * g - d * i, C = d * h - e * g;
    const det = a * A + b * B + c * C;
    if (Math.abs(det) < 1e-12) return null;
    return [
      A, c * h - b * i, b * f - c * e,
      B, a * i - c * g, c * d - a * f,
      C, b * g - a * h, a * e - b * d,
    ].map((v) => v / det);
  }

  // Apply H to a 2D point. Returns null if the point falls on or behind the
  // horizon of the mapping (cannot be drawn).
  function applyHomography(H, [x, y]) {
    if (!H) return null;
    const w = H[6] * x + H[7] * y + H[8];
    if (w <= 1e-9) return null;
    return [(H[0] * x + H[1] * y + H[2]) / w, (H[3] * x + H[4] * y + H[5]) / w];
  }

  // ---- Geometry helpers -------------------------------------------------

  function pointInPolygon([x, y], pts) {
    let inside = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [xi, yi] = pts[i];
      const [xj, yj] = pts[j];
      if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  function centroid(pts) {
    let x = 0, y = 0;
    for (const p of pts) { x += p[0]; y += p[1]; }
    return [x / pts.length, y / pts.length];
  }

  // Polygons of the detection's own mapping set that contain it.
  const polygonsAt = (d) => state.geometry.polygons
    .filter((poly) => poly.setId === d.setId && pointInPolygon([d.x, d.y], poly.points));

  // Ids of polygons containing at least one current detection.
  function hitIds() {
    const ids = new Set();
    for (const d of state.detections) polygonsAt(d).forEach((poly) => ids.add(poly.id));
    return ids;
  }

  // One line of text per detection, for the sidebars.
  function describeDetections() {
    if (!state.detections.length) return '—';
    return state.detections.map((d) => {
      const set = sets().find((s) => s.id === d.setId);
      const inside = polygonsAt(d).map((p) => p.name || '(unnamed)');
      return `cam ${d.view} ${d.source} · ${set ? set.name : '?'}: (${Math.round(d.x)}, ${Math.round(d.y)})`
        + (inside.length ? `\n  in ${inside.join(', ')}` : '');
    }).join('\n');
  }

  // Find a handle under (x, y) across all sets, preferring the active set.
  // `pointsOf(set)` returns that set's four handles in canvas pixels.
  function pickHandle(pointsOf, x, y, radius = 14) {
    const order = [activeSet(), ...sets().filter((s) => s !== activeSet())];
    for (const set of order) {
      const index = pick(pointsOf(set), x, y, radius);
      if (index >= 0) return { set, index };
    }
    return null;
  }

  // Index of the first point within `radius` of (x, y), or -1.
  function pick(points, x, y, radius = 12) {
    for (let i = 0; i < points.length; i++) {
      if (points[i] && Math.hypot(points[i][0] - x, points[i][1] - y) <= radius) return i;
    }
    return -1;
  }

  // ---- Canvas helpers ---------------------------------------------------

  // Match the canvas backing store to its CSS size; returns CSS-pixel size.
  function fitCanvas(canvas) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { ctx, w, h };
  }

  // Draw polygons through `map` (true geometry -> canvas pixels). Pass
  // `setId` to draw only one mapping set's polygons.
  // Straight lines stay straight under a homography, so mapping the vertices
  // is an exact warp of the shape.
  function drawPolygons(ctx, map, opts = {}) {
    const { fillAlpha = 0.35, selectedId = null, labels = true, setId = null } = opts;
    const hits = hitIds();
    for (const poly of state.geometry.polygons) {
      if (setId && poly.setId !== setId) continue;
      const pts = poly.points.map(map);
      if (pts.some((p) => !p)) continue;
      ctx.beginPath();
      pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
      ctx.closePath();
      const hit = hits.has(poly.id);
      ctx.globalAlpha = hit ? Math.min(1, fillAlpha + 0.45) : fillAlpha;
      ctx.fillStyle = poly.color;
      ctx.fill();
      ctx.globalAlpha = 1;
      ctx.lineWidth = poly.id === selectedId || hit ? 4 : 2;
      ctx.strokeStyle = hit ? '#fff' : poly.color;
      ctx.stroke();
      if (labels && poly.name) {
        const c = map(centroid(poly.points));
        if (c) drawLabel(ctx, poly.name, c[0], c[1]);
      }
    }
  }

  // Draw the true-geometry grid through homography H (true geometry -> canvas
  // pixels) as an unbounded plane: lines are generated for whatever part of
  // the plane is visible inside `rect` {x, y, w, h}, wherever the mapping set
  // sits in the true geometry. `refs` are the set's reference points.
  function drawGrid(ctx, H, rect, refs, spacing = 100) {
    const inverse = invertHomography(H);
    if (!inverse) return;

    // Never generate lines further than this from the reference points, so
    // a view that looks towards the plane's horizon stays cheap to draw.
    const xs = refs.map((p) => p[0]), ys = refs.map((p) => p[1]);
    const reach = 10 * Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys), spacing);
    let x0 = Math.min(...xs) - reach, x1 = Math.max(...xs) + reach;
    let y0 = Math.min(...ys) - reach, y1 = Math.max(...ys) + reach;

    // The part of the plane seen through `rect`. If a corner looks past the
    // horizon the visible part is unbounded, and the limit above applies.
    const corners = [[rect.x, rect.y], [rect.x + rect.w, rect.y], [rect.x + rect.w, rect.y + rect.h], [rect.x, rect.y + rect.h]]
      .map((p) => applyHomography(inverse, p));
    if (corners.every(Boolean)) {
      x0 = Math.max(x0, Math.min(...corners.map((p) => p[0])));
      x1 = Math.min(x1, Math.max(...corners.map((p) => p[0])));
      y0 = Math.max(y0, Math.min(...corners.map((p) => p[1])));
      y1 = Math.min(y1, Math.max(...corners.map((p) => p[1])));
    }
    if (x0 >= x1 || y0 >= y1) return;

    let step = spacing;
    while ((x1 - x0) / step > 300 || (y1 - y0) / step > 300) step *= 2;

    // Clip each line to the visible side of the horizon (w > 0) before
    // projecting it; the canvas clips the rest.
    const w = ([x, y]) => H[6] * x + H[7] * y + H[8];
    const near = 0.02 * Math.abs(w(refs[0]));
    const project = ([x, y]) => {
      const k = w([x, y]);
      return [(H[0] * x + H[1] * y + H[2]) / k, (H[3] * x + H[4] * y + H[5]) / k];
    };
    const line = (a, b) => {
      const wa = w(a), wb = w(b);
      if (wa < near && wb < near) return;
      const cut = (t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
      if (wa < near) a = cut((near - wa) / (wb - wa));
      else if (wb < near) b = cut((near - wa) / (wb - wa));
      ctx.moveTo(...project(a));
      ctx.lineTo(...project(b));
    };

    ctx.save();
    ctx.beginPath();
    ctx.rect(rect.x, rect.y, rect.w, rect.h);
    ctx.clip();
    ctx.beginPath();
    for (let x = Math.ceil(x0 / step) * step; x <= x1; x += step) line([x, y0], [x, y1]);
    for (let y = Math.ceil(y0 / step) * step; y <= y1; y += step) line([x0, y], [x1, y]);
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.restore();
  }

  function drawLabel(ctx, text, x, y, color = '#fff', align = 'center') {
    ctx.font = '600 13px system-ui, sans-serif';
    ctx.textAlign = align;
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.75)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  // A draggable/reference marker: ring with a centre dot and a letter.
  function drawHandle(ctx, x, y, label, color = '#ffe14d') {
    ctx.beginPath();
    ctx.arc(x, y, 10, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    ctx.fill();
    ctx.lineWidth = 2;
    ctx.strokeStyle = color;
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 2, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    drawLabel(ctx, label, x + 12, y - 15, color, 'left');
  }

  // A mapping set's four handles joined by a dashed outline. Inactive sets
  // are dimmed; handle A also carries the set's name.
  function drawQuad(ctx, pts, set) {
    ctx.save();
    ctx.globalAlpha = set === activeSet() ? 1 : 0.4;
    ctx.beginPath();
    pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
    ctx.closePath();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = set.color;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);
    pts.forEach(([x, y], i) => drawHandle(ctx, x, y, i ? REF_LABELS[i] : `A · ${set.name}`, set.color));
    ctx.restore();
  }

  // Fill a <select> with the mapping sets and keep it on `value`.
  function fillSetSelect(select, value) {
    select.innerHTML = '';
    for (const set of sets()) select.add(new Option(set.name, set.id));
    select.value = value;
  }

  // Crosshair for a detected point.
  function drawDetection(ctx, x, y) {
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(x, y, 14, 0, Math.PI * 2);
    ctx.moveTo(x - 22, y); ctx.lineTo(x - 6, y);
    ctx.moveTo(x + 6, y); ctx.lineTo(x + 22, y);
    ctx.moveTo(x, y - 22); ctx.lineTo(x, y - 6);
    ctx.moveTo(x, y + 6); ctx.lineTo(x, y + 22);
    ctx.stroke();
  }

  return {
    WORLD, REF_LABELS, PALETTE, state,
    init, publish, uid, defaultRefs,
    sets, activeSet, setActive, addSet,
    openView, renderSetToggles, bindViewControls, publishDetections,
    polygonsAt, describeDetections, pickHandle, drawQuad, drawGrid, fillSetSelect,
    solveHomography, invertHomography, applyHomography,
    pointInPolygon, centroid, hitIds, pick,
    fitCanvas, drawPolygons, drawLabel, drawHandle, drawDetection,
  };
})();
