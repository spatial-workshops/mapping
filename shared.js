// Shared state, messaging and math for the three projection-mapping pages.
// Loaded as a classic script; everything hangs off the global `PM`.
//
// A "mapping set" is one surface: four reference points A–D with three
// representations (true geometry, projector, camera) and therefore two
// homographies (true geometry -> projector, true geometry <-> camera).
// Every polygon belongs to one mapping set.
//
// Topics on the BroadcastChannel (each is owned by one page):
//   geometry   -> { polygons, sets }      owned by index.html; a set's `refs`
//                                         are its A–D in true-geometry units
//   projector  -> { setId: [[x,y] x4] }   owned by projector.html (normalised to window)
//   camera     -> { setId: [[x,y] x4] }   owned by camera.html    (normalised to video frame)
//   detections -> [{x,y,source,setId}]    owned by camera.html    (true-geometry coordinates)
//   active     -> setId                   the set being edited, shared by all pages
//   hello      -> a page just opened; owners re-broadcast what they own

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

  const PERSISTED = ['geometry', 'projector', 'camera', 'active'];
  const state = {
    geometry: {
      polygons: [], // { id, name, color, setId, points: [[x,y], ...] }
      sets: [],     // { id, name, color, refs: [[x,y] x4] }
    },
    projector: {},
    camera: {},
    active: null,
    detections: [],
  };
  const listeners = [];
  let owned = [];

  for (const topic of PERSISTED) {
    try {
      const saved = JSON.parse(localStorage.getItem('pm:' + topic));
      if (saved) state[topic] = saved;
    } catch (err) { /* storage unavailable or corrupt: keep defaults */ }
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
    for (const t of ['projector', 'camera']) {
      if (Array.isArray(state[t])) state[t] = { [first]: state[t] };
      else if (!state[t]) state[t] = {};
    }
    if (!g.sets.some((s) => s.id === state.active)) state.active = first;
  }
  normalise();

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

  // A set's four points on the projector or camera page ('projector' | 'camera').
  function quad(topic, set) {
    if (!state[topic][set.id]) state[topic][set.id] = defaultQuad(sets().indexOf(set));
    return state[topic][set.id];
  }

  function resetQuad(topic, set) {
    state[topic][set.id] = defaultQuad(sets().indexOf(set));
    publish(topic);
  }

  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  const channel = new BroadcastChannel('projection-mapping');

  channel.onmessage = (e) => {
    const { topic, data } = e.data || {};
    if (topic === 'hello') {
      owned.forEach((t) => channel.postMessage({ topic: t, data: state[t] }));
      return;
    }
    if (!(topic in state)) return;
    state[topic] = data;
    normalise();
    listeners.forEach((fn) => fn(topic));
  };

  // Call once per page with the topics that page is the source of truth for.
  function init(ownedTopics, onChange) {
    owned = ownedTopics;
    if (onChange) listeners.push(onChange);
    channel.postMessage({ topic: 'hello' });
  }

  // Save and broadcast a topic after mutating PM.state[topic].
  function publish(topic) {
    if (PERSISTED.includes(topic)) {
      try { localStorage.setItem('pm:' + topic, JSON.stringify(state[topic])); } catch (err) { /* ignore */ }
    }
    channel.postMessage({ topic, data: state[topic] });
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
      return `${d.source} · ${set ? set.name : '?'}: (${Math.round(d.x)}, ${Math.round(d.y)})`
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
    init, publish, uid,
    sets, activeSet, setActive, addSet, quad, resetQuad,
    polygonsAt, describeDetections, pickHandle, drawQuad, fillSetSelect,
    solveHomography, invertHomography, applyHomography,
    pointInPolygon, centroid, hitIds, pick,
    fitCanvas, drawPolygons, drawLabel, drawHandle, drawDetection,
  };
})();
