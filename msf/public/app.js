(() => {
  const $ = (id) => document.getElementById(id);
  const { esc, fmtTime, fmtRange, fmtDay, category, status, where } = MSF;
  // The Android app injects MSFNative (Mist SDK bridge). In a plain browser it's absent.
  const native = window.MSFNative || null;

  const state = {
    info: null,
    day: null,
    events: [],
    cat: '',
    q: '',
    open: null,
    view: 'schedule',
    maps: [],
    locations: [],
    dest: null,
  };

  // ---------- schedule ----------
  function renderDays() {
    const today = MSF.now().date;
    $('days').innerHTML = state.info.days.map((d) => `
      <button class="day${d === today ? ' today' : ''}" data-day="${d}" aria-selected="${d === state.day}">
        <small>${fmtDay(d, { weekday: 'short' })}</small><b>${fmtDay(d, { month: 'short', day: 'numeric' })}</b>
      </button>`).join('') || '<span class="sub">No fair days set yet</span>';
    const sel = $('days').querySelector('[aria-selected="true"]');
    if (sel) sel.scrollIntoView({ inline: 'center', block: 'nearest' });
  }

  function renderChips() {
    const used = new Set(state.events.map((e) => e.category || 'other'));
    const cats = MSF.CATEGORIES.filter((c) => used.has(c.id));
    $('chips').innerHTML = [`<button class="chip" data-cat="" aria-pressed="${!state.cat}">All</button>`]
      .concat(cats.map((c) => `<button class="chip" data-cat="${c.id}" aria-pressed="${state.cat === c.id}"><span class="dot" style="background:${c.color}"></span>${esc(c.label)}</button>`))
      .join('');
  }

  function renderList() {
    const q = state.q.toLowerCase();
    const n = MSF.now();
    const list = state.events.filter((e) =>
      (!state.cat || (e.category || 'other') === state.cat) &&
      (!q || [e.title, e.description, e.location_name, e.location_text].join(' ').toLowerCase().includes(q)));
    if (!list.length) {
      $('list').innerHTML = `<div class="empty">${state.events.length ? 'No events match.' : 'No events posted for this day yet.'}</div>`;
      return;
    }
    const groups = { now: [], upcoming: [], past: [] };
    for (const e of list) {
      const s = status(e, n);
      (groups[s === 'cancelled' ? (e.date === n.date && e.start_time < n.time ? 'past' : 'upcoming') : s] || groups.upcoming).push(e);
    }
    const isToday = state.day === n.date;
    const section = (label, items) => items.length ? `<div class="group-label">${label}</div>${items.map(card).join('')}` : '';
    $('list').innerHTML = isToday
      ? section('Happening now', groups.now) + section('Coming up', groups.upcoming) + section('Earlier today', groups.past)
      : section(fmtDay(state.day, { weekday: 'long', month: 'long', day: 'numeric' }), list);
  }

  function card(e) {
    const s = status(e);
    const c = category(e.category);
    const mapped = e.map_id && e.x != null;
    return `
      <article class="event ${s}${state.open === e.id ? ' open' : ''}" style="--cat:${c.color}" data-id="${e.id}">
        <div class="time">${fmtTime(e.start_time)}${e.end_time ? `<small>to ${fmtTime(e.end_time)}</small>` : ''}</div>
        <div>
          <h3>${esc(e.title)}</h3>
          <div class="meta">
            ${s === 'now' ? '<span class="badge now">Now</span>' : ''}
            ${e.cancelled ? '<span class="badge cancel">Cancelled</span>' : ''}
            ${e.featured ? '<span class="badge feat">Featured</span>' : ''}
            <span>${esc(where(e) || c.label)}</span>
          </div>
          ${e.description ? `<div class="desc">${esc(e.description)}</div>` : ''}
          ${mapped ? `<div class="actions"><button class="btn primary" data-go="${e.location_id}">${native ? 'Directions' : 'Show on map'}</button></div>` : ''}
        </div>
      </article>`;
  }

  async function loadDay(day, refresh) {
    if (!refresh) state.open = null;
    state.day = day;
    renderDays();
    try {
      const r = await MSF.api(`/api/events?date=${day}`);
      MSF.setNow(r.now);
      state.events = r.events;
    } catch {
      state.events = [];
    }
    renderChips();
    renderList();
  }

  // ---------- map ----------
  const mv = MapView($('mapwrap'), { onPin: (p) => showPin(p) });

  async function loadMaps() {
    if (state.maps.length) return;
    const [m, l] = await Promise.all([MSF.api('/api/maps').catch(() => ({ maps: [] })), MSF.api('/api/locations')]);
    state.maps = m.maps;
    state.locations = l.locations;
    $('mapPick').innerHTML = state.maps.map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('');
    $('mapPick').hidden = state.maps.length < 2;
    $('destPick').innerHTML = '<option value="">Choose a destination…</option>' +
      state.locations.filter((x) => x.map_id && x.x != null).map((x) => `<option value="${x.id}">${esc(x.name)}</option>`).join('');
    if (!state.maps.length) {
      $('mapNote').textContent = 'The fairgrounds map is not available right now.';
      return;
    }
    mv.setMap(state.maps[0]);
    mv.setPins(state.locations);
  }

  async function showPin(p) {
    mv.select(p.id);
    $('destPick').value = p.id;
    const day = MSF.now().date;
    const r = await MSF.api(`/api/events?date=${day}`).catch(() => ({ events: [] }));
    const here = r.events.filter((e) => e.location_id === p.id && status(e) !== 'past');
    $('pinInfo').innerHTML = `
      <div class="group-label">${esc(p.name)}${here.length ? ' · today' : ''}</div>
      ${here.length ? here.map(card).join('') : '<div class="empty" style="padding:14px">Nothing else scheduled here today.</div>'}
      ${native ? `<button class="btn primary" data-route="${p.id}">Directions to ${esc(p.name)}</button>` : ''}`;
  }

  function goTo(locId) {
    const p = state.locations.find((x) => x.id === Number(locId));
    if (!p) return;
    const m = state.maps.find((x) => x.id === p.map_id);
    if (m) { mv.setMap(m); $('mapPick').value = m.id; }
    mv.focus(p.x, p.y);
    showPin(p);
    if (native) startRoute(p);
  }

  // ---------- Mist SDK bridge (Android app only) ----------
  let lastDot = null;
  function startRoute(p) {
    state.dest = p;
    $('clearRoute').hidden = false;
    requestRoute();
  }
  function requestRoute() {
    if (!native || !state.dest) return;
    if (!lastDot) { $('mapNote').textContent = 'Finding your location…'; return; }
    native.route(state.dest.x, state.dest.y);
  }

  window.msfNative = {
    onStatus(text) { $('mapNote').textContent = text; },
    onLocation(x, y, mapId) {
      const first = !lastDot;
      lastDot = { x, y, mapId };
      const m = state.maps.find((v) => v.id === mapId);
      if (m && mv.map && mv.map.id !== mapId) { mv.setMap(m); $('mapPick').value = m.id; }
      mv.setDot({ x, y });
      if (first) { $('mapNote').textContent = 'Blue dot is you.'; requestRoute(); }
    },
    // nodes: [{x, y}] from IndoorLocationManager.getWayFindingPathTo, or [] when no paths are drawn.
    onRoute(json) {
      if (!state.dest) return;
      let nodes = [];
      try { nodes = JSON.parse(json) || []; } catch {}
      const m = mv.map;
      // The SDK may return path nodes in pixels; everything here is meters.
      if (m && nodes.some((n) => n.x > m.width_m * 1.05 || n.y > m.height_m * 1.05)) nodes = nodes.map((n) => ({ x: n.x / m.ppm, y: n.y / m.ppm }));
      let route;
      if (nodes.length) {
        route = [lastDot, ...nodes, { x: state.dest.x, y: state.dest.y }];
      } else {
        route = [lastDot, { x: state.dest.x, y: state.dest.y }];
        route.direct = true;
      }
      mv.setRoute(route);
      const meters = route.slice(1).reduce((s, p, i) => s + Math.hypot(p.x - route[i].x, p.y - route[i].y), 0);
      $('mapNote').textContent = `${route.direct ? 'Straight-line distance' : 'Walking route'} to ${state.dest.name}: about ${Math.round(meters * 3.281)} ft.`;
    },
    onError(text) { $('mapNote').textContent = text; },
  };

  // Recompute the route as the blue dot moves, at most every 5 s.
  setInterval(() => { if (state.dest && lastDot) requestRoute(); }, 5000);

  // ---------- events ----------
  function setView(v) {
    state.view = v;
    document.querySelectorAll('.tabbtn').forEach((b) => b.setAttribute('aria-selected', b.dataset.view === v));
    $('view-schedule').hidden = v !== 'schedule';
    $('view-map').hidden = v !== 'map';
    $('days').hidden = v !== 'schedule';
    if (v === 'map') {
      loadMaps().then(() => mv.fit());
      if (native) native.startLocation();
    } else if (native) {
      native.stopLocation();
    }
  }

  document.addEventListener('click', (e) => {
    const t = e.target.closest('[data-day],[data-cat],[data-view],[data-go],[data-route],.event');
    if (!t) return;
    if (t.dataset.day) return loadDay(t.dataset.day);
    if (t.dataset.cat !== undefined) { state.cat = t.dataset.cat; renderChips(); return renderList(); }
    if (t.dataset.view) return setView(t.dataset.view);
    if (t.dataset.go) { setView('map'); return loadMaps().then(() => goTo(t.dataset.go)); }
    if (t.dataset.route) return goTo(t.dataset.route);
    if (t.classList.contains('event')) {
      const id = Number(t.dataset.id);
      state.open = state.open === id ? null : id;
      if (t.closest('#list')) renderList();
      else t.classList.toggle('open');
    }
  });
  $('search').addEventListener('input', (e) => { state.q = e.target.value; renderList(); });
  $('mapPick').addEventListener('change', (e) => mv.setMap(state.maps.find((m) => m.id === e.target.value)));
  $('destPick').addEventListener('change', (e) => e.target.value && goTo(e.target.value));
  $('clearRoute').addEventListener('click', () => {
    state.dest = null;
    mv.setRoute(null);
    mv.select(null);
    $('clearRoute').hidden = true;
    $('destPick').value = '';
    $('pinInfo').innerHTML = '';
  });

  // ---------- boot ----------
  (async () => {
    const info = await MSF.api('/api/info');
    state.info = info;
    MSF.setNow(info.now);
    $('fairName').textContent = info.fair_name;
    document.title = `${info.fair_name} Events`;
    if (info.fair_start && info.fair_end) $('subline').textContent = `${fmtDay(info.fair_start, { month: 'long', day: 'numeric' })} – ${fmtDay(info.fair_end, { month: 'long', day: 'numeric', year: 'numeric' })}`;
    $('apkBanner').hidden = !info.apk || native || !/Android/i.test(navigator.userAgent);
    const today = info.now.date;
    const day = info.days.includes(today) ? today : (info.days.find((d) => d > today) || info.days[info.days.length - 1] || today);
    await loadDay(day);
    if (new URLSearchParams(location.search).get('view') === 'map') setView('map');
    // Keep "now / coming up" fresh and pick up edits.
    setInterval(() => { if (state.view === 'schedule') loadDay(state.day, true); }, 60000);
  })();
})();
