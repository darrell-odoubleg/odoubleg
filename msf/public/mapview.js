// Pan/zoom floor plan with location pins, a blue dot, and a route line.
// All positions in and out are meters from the map's top-left (Mist SDK units); ppm converts to image pixels.
function MapView(wrap, opts = {}) {
  const stage = wrap.querySelector('.stage');
  const img = wrap.querySelector('img');
  const svg = wrap.querySelector('svg');
  const NS = 'http://www.w3.org/2000/svg';
  let map = null;
  let pins = [];
  let dot = null;
  let route = null;
  let selected = null;
  let view = { s: 1, x: 0, y: 0 };
  let minScale = 0.05;

  function apply() {
    stage.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.s})`;
    draw();
  }

  function fit() {
    if (!map) return;
    const w = wrap.clientWidth, h = wrap.clientHeight;
    const s = Math.min(w / map.width, h / map.height);
    minScale = s * 0.8;
    view = { s, x: (w - map.width * s) / 2, y: (h - map.height * s) / 2 };
    apply();
  }

  function zoomAt(cx, cy, factor) {
    const s = Math.max(minScale, Math.min(view.s * factor, 6));
    const k = s / view.s;
    view = { s, x: cx - (cx - view.x) * k, y: cy - (cy - view.y) * k };
    apply();
  }

  function el(tag, attrs, parent) {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, v);
    (parent || svg).appendChild(n);
    return n;
  }

  function px(m) { return m * map.ppm; }

  // Markers keep a constant on-screen size, so redraw at each zoom.
  function draw() {
    svg.innerHTML = '';
    if (!map) return;
    const r = 1 / view.s;
    if (route && route.length > 1) {
      const pts = route.map((p) => `${px(p.x)},${px(p.y)}`).join(' ');
      el('polyline', { points: pts, fill: 'none', stroke: '#ffffff', 'stroke-width': 10 * r, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' });
      el('polyline', { points: pts, fill: 'none', stroke: '#1565c0', 'stroke-width': 6 * r, 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'stroke-dasharray': route.direct ? `${10 * r} ${8 * r}` : 'none' });
    }
    for (const p of pins) {
      if (p.map_id !== map.id || p.x == null) continue;
      const on = selected === p.id;
      const g = el('g', { class: 'pin', transform: `translate(${px(p.x)},${px(p.y)}) scale(${r})` });
      el('path', { d: 'M0 0 C-4 -8 -12 -12 -12 -20 A12 12 0 1 1 12 -20 C12 -12 4 -8 0 0Z', fill: on ? '#353653' : '#e4332d', stroke: '#fff', 'stroke-width': 2 }, g);
      el('circle', { cx: 0, cy: -20, r: 4.5, fill: '#fff' }, g);
      if (on || opts.labels) {
        const t = el('text', { x: 0, y: -38, 'text-anchor': 'middle', 'font-size': 14, 'font-weight': 700, fill: '#353653', stroke: '#fff', 'stroke-width': 4, 'paint-order': 'stroke' }, g);
        t.textContent = p.name;
      }
    }
    if (dot) {
      const g = el('g', { transform: `translate(${px(dot.x)},${px(dot.y)}) scale(${r})` });
      el('circle', { r: 22, fill: 'rgba(21,101,192,.18)' }, g);
      el('circle', { r: 9, fill: '#1e88e5', stroke: '#fff', 'stroke-width': 3 }, g);
    }
  }

  // ---------- gestures ----------
  const pointers = new Map();
  let moved = false;
  let start = null;
  wrap.addEventListener('pointerdown', (e) => {
    wrap.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    moved = false;
    start = { x: e.clientX, y: e.clientY };
  });
  wrap.addEventListener('pointermove', (e) => {
    if (!pointers.has(e.pointerId)) return;
    const prev = pointers.get(e.pointerId);
    const cur = { x: e.clientX, y: e.clientY };
    if (Math.hypot(cur.x - start.x, cur.y - start.y) > 6) moved = true;
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const other = a === prev ? b : a;
      const d0 = Math.hypot(prev.x - other.x, prev.y - other.y);
      const d1 = Math.hypot(cur.x - other.x, cur.y - other.y);
      const box = wrap.getBoundingClientRect();
      if (d0 > 0) zoomAt((cur.x + other.x) / 2 - box.left, (cur.y + other.y) / 2 - box.top, d1 / d0);
    } else {
      view.x += cur.x - prev.x;
      view.y += cur.y - prev.y;
      apply();
    }
    pointers.set(e.pointerId, cur);
  });
  // Pointer capture sends every event to wrap, so pin taps are found by distance to the pin head.
  function pinAt(sx, sy) {
    let best = null, bestD = 26;
    for (const p of pins) {
      if (p.map_id !== map.id || p.x == null) continue;
      const d = Math.hypot(view.x + px(p.x) * view.s - sx, view.y + px(p.y) * view.s - 20 - sy);
      if (d < bestD) { best = p; bestD = d; }
    }
    return best;
  }
  const up = (e) => {
    if (pointers.has(e.pointerId) && pointers.size === 1 && !moved && map) {
      const box = wrap.getBoundingClientRect();
      const sx = e.clientX - box.left, sy = e.clientY - box.top;
      const hit = opts.onPin && pinAt(sx, sy);
      if (hit) opts.onPin(hit);
      else if (opts.onClick) {
        const ix = (sx - view.x) / view.s, iy = (sy - view.y) / view.s;
        if (ix >= 0 && iy >= 0 && ix <= map.width && iy <= map.height) opts.onClick(ix / map.ppm, iy / map.ppm);
      }
    }
    pointers.delete(e.pointerId);
  };
  wrap.addEventListener('pointerup', up);
  wrap.addEventListener('pointercancel', (e) => pointers.delete(e.pointerId));
  wrap.addEventListener('wheel', (e) => {
    e.preventDefault();
    const box = wrap.getBoundingClientRect();
    zoomAt(e.clientX - box.left, e.clientY - box.top, e.deltaY < 0 ? 1.15 : 1 / 1.15);
  }, { passive: false });
  window.addEventListener('resize', () => fit());

  return {
    get map() { return map; },
    setMap(m) {
      if (map && m && map.id === m.id) return;
      map = m;
      if (!m) { img.removeAttribute('src'); draw(); return; }
      img.onload = fit;
      img.width = m.width;
      img.height = m.height;
      svg.setAttribute('width', m.width);
      svg.setAttribute('height', m.height);
      img.src = `/api/maps/${m.id}/image`;
    },
    setPins(list) { pins = list || []; draw(); },
    setDot(d) { dot = d; draw(); },
    setRoute(r) { route = r; draw(); },
    select(id) { selected = id; draw(); },
    focus(xm, ym, scale) {
      if (!map) return;
      const s = scale || Math.max(view.s, minScale / 0.8 * 2);
      view = { s, x: wrap.clientWidth / 2 - px(xm) * s, y: wrap.clientHeight / 2 - px(ym) * s };
      apply();
    },
    fit,
  };
}
