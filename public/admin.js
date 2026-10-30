(() => {
  const $ = (id) => document.getElementById(id);
  const { esc, fmtRange, fmtDay, category, api } = MSF;
  const state = { info: null, events: [], locations: [], maps: [], settings: {}, editing: null, placing: null, mapsLoaded: false };

  // ---------- auth ----------
  async function boot() {
    const { user } = await api('/api/me');
    $('loginView').hidden = !!user;
    $('appView').hidden = !user;
    if (!user) return;
    $('who').textContent = `Signed in as ${user.name}`;
    await loadInfo();
    await Promise.all([loadLocations(), loadSettings()]);
    await loadEvents();
  }

  $('loginForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('loginErr').textContent = '';
    try {
      await api('/api/login', { method: 'POST', body: { username: $('lu').value, password: $('lp').value } });
      $('lp').value = '';
      boot();
    } catch (err) {
      $('loginErr').textContent = err.message;
    }
  });
  $('logout').addEventListener('click', async () => { await api('/api/logout', { method: 'POST' }); boot(); });

  function guard(err, out) {
    if (err.status === 401) return boot();
    if (out) out.textContent = err.message;
    else alert(err.message);
  }

  // ---------- tabs ----------
  document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => {
    document.querySelectorAll('[data-tab]').forEach((x) => x.setAttribute('aria-selected', x === b));
    for (const t of ['events', 'locations', 'settings']) $(`tab-${t}`).hidden = t !== b.dataset.tab;
    if (b.dataset.tab === 'locations') openLocations();
  }));

  // ---------- data ----------
  async function loadInfo() {
    state.info = await api('/api/info');
    MSF.setNow(state.info.now);
    const sel = $('dayFilter');
    const cur = sel.value;
    sel.innerHTML = '<option value="">All days</option>' +
      state.info.days.map((d) => `<option value="${d}">${fmtDay(d, { weekday: 'short', month: 'short', day: 'numeric' })}</option>`).join('');
    sel.value = cur && state.info.days.includes(cur) ? cur : '';
  }

  async function loadEvents() {
    state.events = (await api('/api/events')).events;
    renderEvents();
  }

  async function loadLocations() {
    state.locations = (await api('/api/locations')).locations;
    $('fLoc').innerHTML = '<option value="">— none —</option>' + state.locations.map((l) => `<option value="${l.id}">${esc(l.name)}</option>`).join('');
    renderLocations();
  }

  async function loadSettings() {
    const s = (await api('/api/settings')).settings;
    state.settings = s;
    $('sName').value = s.fair_name;
    $('sStart').value = s.fair_start;
    $('sEnd').value = s.fair_end;
    $('sSpeed').value = s.kiosk_speed;
    $('sMist').value = s.mist_sdk_token;
    $('kioskUrl').textContent = `${location.origin}/kiosk`;
    $('apkInfo').innerHTML = state.info && state.info.apk
      ? `Download and install on Android phones from <a href="/download">${location.origin}/download</a> (allow "install unknown apps" the first time).`
      : 'The Android app has not been published to this server yet.';
  }

  // ---------- events ----------
  function renderEvents() {
    const day = $('dayFilter').value;
    const q = $('evSearch').value.toLowerCase();
    const rows = state.events.filter((e) => (!day || e.date === day) &&
      (!q || [e.title, e.location_name, e.location_text, e.category].join(' ').toLowerCase().includes(q)));
    $('evRows').innerHTML = rows.map((e) => `
      <tr>
        <td>${fmtDay(e.date)}</td>
        <td style="white-space:nowrap">${fmtRange(e)}</td>
        <td><b>${esc(e.title)}</b>${e.cancelled ? ' <span class="badge cancel">Cancelled</span>' : ''}${e.featured ? ' <span class="badge feat">Featured</span>' : ''}
          <div class="muted">${esc(category(e.category).label)}</div></td>
        <td>${esc(MSF.where(e))}</td>
        <td style="white-space:nowrap"><button class="btn" data-edit="${e.id}">Edit</button></td>
      </tr>`).join('') || `<tr><td colspan="5" class="muted" style="padding:20px">${state.events.length ? 'No events match.' : 'No events yet. Set the fair dates in Settings, then add events.'}</td></tr>`;
  }

  $('dayFilter').addEventListener('change', renderEvents);
  $('evSearch').addEventListener('input', renderEvents);
  $('evRows').addEventListener('click', (e) => {
    const b = e.target.closest('[data-edit]');
    if (b) openEvent(state.events.find((x) => x.id === Number(b.dataset.edit)));
  });
  $('addEvent').addEventListener('click', () => openEvent(null));

  $('fCat').innerHTML = MSF.CATEGORIES.map((c) => `<option value="${c.id}">${esc(c.label)}</option>`).join('');

  function openEvent(ev, asCopy) {
    state.editing = ev && !asCopy ? ev : null;
    const editing = !!state.editing;
    $('evTitle').textContent = editing ? 'Edit event' : asCopy ? 'Duplicate event' : 'Add event';
    $('evErr').textContent = '';
    $('fTitle').value = ev ? ev.title : '';
    $('fStart').value = ev ? ev.start_time : '';
    $('fEnd').value = ev ? ev.end_time || '' : '';
    $('fLoc').value = ev && ev.location_id ? ev.location_id : '';
    $('fLocText').value = ev ? ev.location_text || '' : '';
    $('fCat').value = ev ? ev.category || 'other' : 'other';
    $('fDesc').value = ev ? ev.description || '' : '';
    $('fFeat').checked = !!(ev && ev.featured);
    $('fCancel').checked = !!(ev && ev.cancelled);
    $('fDatesWrap').hidden = editing;
    $('fDateWrap').hidden = !editing;
    $('evDelete').hidden = !editing;
    $('evDup').hidden = !editing;
    if (editing) {
      $('fDate').value = ev.date;
    } else {
      const days = state.info.days.length ? state.info.days : [MSF.now().date];
      const pre = ev ? ev.date : $('dayFilter').value;
      $('fDates').innerHTML = days.map((d) => `<label><input type="checkbox" value="${d}" ${d === pre ? 'checked' : ''}><span>${fmtDay(d)}</span></label>`).join('') +
        (state.info.days.length ? '' : '<span class="muted">Set fair dates in Settings to pick from fair days.</span>');
      if (!state.info.days.length) { $('fDateWrap').hidden = false; $('fDate').value = pre || MSF.now().date; }
    }
    $('evDialog').showModal();
    $('fTitle').focus();
  }

  function formBody() {
    return {
      title: $('fTitle').value,
      start_time: $('fStart').value,
      end_time: $('fEnd').value,
      location_id: $('fLoc').value,
      location_text: $('fLocText').value,
      category: $('fCat').value,
      description: $('fDesc').value,
      featured: $('fFeat').checked,
      cancelled: $('fCancel').checked,
    };
  }

  $('evForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('evErr').textContent = '';
    const body = formBody();
    try {
      if (state.editing) {
        await api(`/api/events/${state.editing.id}`, { method: 'PUT', body: { ...body, date: $('fDate').value } });
      } else {
        const dates = [...$('fDates').querySelectorAll('input:checked')].map((i) => i.value);
        if (!$('fDateWrap').hidden && $('fDate').value) dates.push($('fDate').value);
        await api('/api/events', { method: 'POST', body: { ...body, dates } });
      }
      $('evDialog').close();
      await loadInfo();
      await loadEvents();
    } catch (err) {
      guard(err, $('evErr'));
    }
  });

  $('evDup').addEventListener('click', () => {
    const ev = { ...state.editing, ...formBody(), date: $('fDate').value };
    $('evDialog').close();
    openEvent(ev, true);
  });

  $('evDelete').addEventListener('click', async () => {
    if (!state.editing || !confirm(`Delete "${state.editing.title}" on ${fmtDay(state.editing.date)}?`)) return;
    try {
      await api(`/api/events/${state.editing.id}`, { method: 'DELETE' });
      $('evDialog').close();
      await loadInfo();
      await loadEvents();
    } catch (err) {
      guard(err, $('evErr'));
    }
  });
  $('evCancel').addEventListener('click', () => $('evDialog').close());

  // ---------- locations ----------
  const mv = MapView($('locMapWrap'), {
    labels: true,
    onPin: (p) => { setPlacing(p.id); },
    onClick: async (x, y) => {
      const loc = state.locations.find((l) => l.id === state.placing);
      if (!loc) { $('locHint').textContent = 'Pick a location in the list first ("Set on map").'; return; }
      try {
        await api(`/api/locations/${loc.id}`, { method: 'PUT', body: { ...loc, map_id: mv.map.id, x: +x.toFixed(2), y: +y.toFixed(2) } });
        await loadLocations();
        mv.setPins(state.locations);
        $('locHint').innerHTML = `<span class="ok">Placed ${esc(loc.name)}.</span> Click again to move it, or pick another location.`;
      } catch (err) {
        guard(err, $('locErr'));
      }
    },
  });

  function setPlacing(id) {
    state.placing = id;
    mv.select(id);
    const loc = state.locations.find((l) => l.id === id);
    $('locHint').textContent = loc ? `Click the map where ${loc.name} is.` : '';
    renderLocations();
  }

  async function openLocations() {
    if (!state.mapsLoaded) {
      try {
        state.maps = (await api('/api/maps')).maps;
      } catch (err) {
        $('locHint').textContent = 'Could not load floor plans from Mist.';
      }
      state.mapsLoaded = true;
      $('locMap').innerHTML = state.maps.map((m) => `<option value="${m.id}">${esc(m.name)}</option>`).join('');
      if (state.maps[0]) mv.setMap(state.maps[0]);
    }
    mv.setPins(state.locations);
    requestAnimationFrame(() => mv.fit());
  }
  $('locMap').addEventListener('change', (e) => mv.setMap(state.maps.find((m) => m.id === e.target.value)));

  function renderLocations() {
    $('locRows').innerHTML = state.locations.map((l) => `
      <tr${state.placing === l.id ? ' style="background:var(--now)"' : ''}>
        <td><b>${esc(l.name)}</b> <span class="muted">#${l.id}</span>${l.notes ? `<div class="muted">${esc(l.notes)}</div>` : ''}</td>
        <td>${l.x != null ? '✓ placed' : '<span class="muted">not yet</span>'}</td>
        <td style="white-space:nowrap">
          <button class="btn" data-place="${l.id}">Set on map</button>
          <button class="btn" data-rename="${l.id}">Rename</button>
          <button class="btn danger" data-delloc="${l.id}">Delete</button>
        </td>
      </tr>`).join('') || '<tr><td colspan="3" class="muted">No locations yet. Add buildings, stages, and barns above.</td></tr>';
  }

  $('locRows').addEventListener('click', async (e) => {
    const t = e.target.closest('button');
    if (!t) return;
    const loc = state.locations.find((l) => l.id === Number(t.dataset.place || t.dataset.rename || t.dataset.delloc));
    if (!loc) return;
    try {
      if (t.dataset.place) {
        setPlacing(loc.id);
        if (loc.x != null) mv.focus(loc.x, loc.y);
        $('locMapWrap').scrollIntoView({ behavior: 'smooth', block: 'center' });
      } else if (t.dataset.rename) {
        const name = prompt('Location name', loc.name);
        if (!name) return;
        await api(`/api/locations/${loc.id}`, { method: 'PUT', body: { ...loc, name } });
      } else if (t.dataset.delloc) {
        const used = state.events.filter((ev) => ev.location_id === loc.id).length;
        if (!confirm(`Delete ${loc.name}?${used ? ` ${used} event(s) use it and will keep their detail text only.` : ''}`)) return;
        await api(`/api/locations/${loc.id}`, { method: 'DELETE' });
        if (state.placing === loc.id) state.placing = null;
      }
      if (!t.dataset.place) {
        await loadLocations();
        await loadEvents();
        mv.setPins(state.locations);
      }
    } catch (err) {
      guard(err, $('locErr'));
    }
  });

  $('locForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('locErr').textContent = '';
    try {
      const { id } = await api('/api/locations', { method: 'POST', body: { name: $('locName').value, notes: $('locNotes').value, sort: state.locations.length } });
      $('locName').value = '';
      $('locNotes').value = '';
      await loadLocations();
      setPlacing(id);
      mv.setPins(state.locations);
    } catch (err) {
      guard(err, $('locErr'));
    }
  });

  // ---------- settings ----------
  $('setForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    $('setErr').textContent = '';
    try {
      await api('/api/settings', { method: 'PUT', body: {
        fair_name: $('sName').value, fair_start: $('sStart').value, fair_end: $('sEnd').value,
        kiosk_speed: $('sSpeed').value, mist_sdk_token: $('sMist').value,
      } });
      await loadInfo();
      await loadSettings();
      $('setErr').innerHTML = '<span class="ok">Saved.</span>';
    } catch (err) {
      guard(err, $('setErr'));
    }
  });

  boot();
})();
