(() => {
  const $ = (id) => document.getElementById(id);
  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    Object.entries(props || {}).forEach(([k, v]) => {
      if (k === 'class') n.className = v;
      else if (k === 'onclick') n.addEventListener('click', v);
      else if (k.startsWith('aria-')) n.setAttribute(k, v);
      else n[k] = v;
    });
    kids.flat().forEach((c) => c != null && n.append(c));
    return n;
  }
  async function api(url, opts) {
    const res = await fetch(url, opts);
    if (res.status === 401) { location.href = '/login.html'; throw new Error('Signed out'); }
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || 'Request failed');
    return out;
  }

  const day = (s) => new Date(`${s}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const span = (a, b) => (a === b ? day(a) : `${day(a)} to ${day(b)}`);
  const when = (s) => new Date(`${s.replace(' ', 'T')}Z`).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

  let statuses = [];
  let requests = [];
  let current = null;

  function renderList() {
    const f = $('filter').value;
    const shown = requests.filter((r) => f === 'all' || r.status === f);
    $('state').hidden = shown.length > 0;
    $('state').textContent = requests.length ? 'No requests with this status.' : 'No requests yet. They\'ll show up here as people send them.';
    $('list').hidden = !shown.length;
    $('list').replaceChildren(...shown.map((r) => el('li', {}, el('button', {
      type: 'button', 'aria-current': String(r.id === current), onclick: () => open(r.id),
    },
      el('span', { class: 'req-title' }, el('span', {}, r.event_name), el('span', { class: `badge ${r.status}` }, r.status)),
      el('span', { class: 'req-sub' }, `${r.name}${r.company ? `, ${r.company}` : ''}`),
      el('span', { class: 'req-sub' }, `${span(r.start_date, r.end_date)} · ${r.city_state} · ${r.item_count} item${r.item_count === 1 ? '' : 's'}`)))));
  }

  async function load() {
    const out = await api('/api/admin/requests');
    statuses = out.statuses;
    requests = out.requests;
    const sel = $('filter');
    if (!sel.options.length) {
      sel.append(el('option', { value: 'all' }, 'All requests'), ...statuses.map((s) => el('option', { value: s }, s)));
    }
    renderList();
  }

  const row = (label, value) => (value ? [el('dt', {}, label), el('dd', {}, value)] : []);

  async function open(id) {
    const r = await api(`/api/admin/requests/${id}`);
    current = id;
    renderList();
    const status = el('select', { id: 'status', 'aria-label': 'Status' }, statuses.map((s) => el('option', { value: s, selected: s === r.status }, s)));
    const notes = el('textarea', { id: 'internal', rows: 3, maxLength: 5000, value: r.internal_notes });
    const saved = el('span', { class: 'muted', role: 'status' });
    const save = el('button', {
      type: 'button', class: 'btn btn-go',
      onclick: async () => {
        saved.textContent = '';
        try {
          await api(`/api/admin/requests/${id}`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: status.value, internal_notes: notes.value }) });
          await load();
          saved.textContent = 'Saved';
        } catch (e) { saved.textContent = e.message; }
      },
    }, 'Save');

    $('detail').replaceChildren(...[
      el('h2', {}, r.event_name),
      el('p', { class: 'muted' }, `${r.ref}, received ${when(r.created_at)}`),
      el('h3', {}, 'Contact'),
      el('dl', {},
        row('Name', r.name), row('Company', r.company),
        row('Email', el('a', { href: `mailto:${encodeURIComponent(r.email).replace(/%40/, '@')}?subject=${encodeURIComponent(`Backline request ${r.ref}`)}` }, r.email)),
        row('Phone', el('a', { href: `tel:${r.phone.replace(/[^\d+]/g, '')}` }, r.phone))),
      el('h3', {}, 'Show'),
      el('dl', {},
        row('Dates', span(r.start_date, r.end_date)), row('Artist', r.artist), row('Venue', r.venue),
        row('City', r.city_state), row('Getting gear', r.delivery)),
      r.notes ? [el('h3', {}, 'Notes'), el('p', { class: 'pre' }, r.notes)] : null,
      el('h3', {}, 'Gear'),
      r.items.length ? el('table', { class: 'pick' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Qty'), el('th', {}, 'Item'), el('th', {}, 'Make or size'))),
        el('tbody', {}, r.items.map((i) => el('tr', {}, el('td', {}, String(i.qty)), el('td', {}, i.gear, i.category === 'Custom request' ? el('span', { class: 'tag' }, 'Custom') : null), el('td', {}, i.spec))))) : null,
      el('h3', {}, 'Your follow-up'),
      el('div', { class: 'field' }, el('label', { htmlFor: 'status' }, 'Status'), status),
      el('div', { class: 'field' }, el('label', { htmlFor: 'internal' }, 'Private notes'), notes),
      el('div', { class: 'save-row' }, save, saved),
    ].flat().filter(Boolean));
    $('detail').hidden = false;
    if (window.matchMedia('(max-width: 860px)').matches) $('detail').scrollIntoView();
  }

  // Products --------------------------------------------------------------------
  const NEW_CATEGORY = '__new';
  let catalog = { categories: [], items: [] };

  function renderProducts() {
    const words = $('prod-search').value.toLowerCase().split(/\s+/).filter(Boolean);
    const match = (i) => words.every((w) => `${i.name} ${i.category} ${i.makes.join(' ')}`.toLowerCase().includes(w));
    $('prod-count').textContent = `${catalog.items.length} on the rentals page`;
    const groups = catalog.categories.map((cat) => {
      const rows = catalog.items.filter((i) => i.category === cat && match(i));
      if (!rows.length) return null;
      return el('section', { class: 'prod-group' }, el('h2', {}, cat), el('ul', {}, rows.map((i) => el('li', {},
        el('div', {}, el('span', { class: 'gear-name' }, i.name), i.makes.length ? el('span', { class: 'gear-makes' }, i.makes.join(' · ')) : null),
        el('button', { type: 'button', class: 'btn-del', 'aria-label': `Delete ${i.name}`, onclick: () => del(i) }, 'Delete')))));
    }).filter(Boolean);
    $('prod-list').replaceChildren(...(groups.length ? groups : [el('p', { class: 'state' }, 'No products match.')]));
  }

  function renderCategories() {
    const sel = $('add-category');
    const keep = sel.value;
    sel.replaceChildren(...catalog.categories.map((c) => el('option', { value: c }, c)), el('option', { value: NEW_CATEGORY }, 'New category…'));
    if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
    $('add-new-wrap').hidden = sel.value !== NEW_CATEGORY;
  }

  async function loadProducts() {
    catalog = await api('/api/catalog');
    renderCategories();
    renderProducts();
  }

  async function del(item) {
    if (!window.confirm(`Delete "${item.name}"? Customers won't see it anymore. Past requests keep it.`)) return;
    $('prod-msg').hidden = true;
    try {
      await api(`/api/admin/products/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
    } catch (e) {
      $('prod-msg').textContent = e.message;
      $('prod-msg').hidden = false;
    }
    await loadProducts().catch(() => {});
    $('prod-search').focus();
  }

  $('add-category').addEventListener('change', () => {
    $('add-new-wrap').hidden = $('add-category').value !== NEW_CATEGORY;
    if (!$('add-new-wrap').hidden) $('add-new').focus();
  });
  $('prod-search').addEventListener('input', renderProducts);
  $('add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const isNew = $('add-category').value === NEW_CATEGORY;
    $('add-err').hidden = true;
    $('add-ok').textContent = '';
    try {
      const p = await api('/api/admin/products', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: $('add-name').value, category: isNew ? $('add-new').value : $('add-category').value, makes: $('add-makes').value }),
      });
      $('add-name').value = '';
      $('add-makes').value = '';
      $('add-new').value = '';
      await loadProducts();
      $('add-category').value = p.category;
      $('add-new-wrap').hidden = true;
      $('add-ok').textContent = `Added "${p.name}" under ${p.category}.`;
      $('add-name').focus();
    } catch (err) {
      $('add-err').textContent = err.message;
      $('add-err').hidden = false;
    }
  });

  function showTab() {
    const products = location.hash === '#products';
    $('view-requests').hidden = products;
    $('view-products').hidden = !products;
    $('tab-requests').setAttribute('aria-pressed', String(!products));
    $('tab-products').setAttribute('aria-pressed', String(products));
    if (products) loadProducts().catch((e) => { $('prod-msg').textContent = e.message; $('prod-msg').hidden = false; });
    else load().catch((e) => { $('state').textContent = e.message; });
  }
  $('tab-requests').addEventListener('click', () => { history.replaceState(null, '', '#requests'); showTab(); });
  $('tab-products').addEventListener('click', () => { history.replaceState(null, '', '#products'); showTab(); });
  window.addEventListener('hashchange', showTab);

  $('filter').addEventListener('change', renderList);
  $('logout').addEventListener('click', async () => {
    await fetch('/api/logout', { method: 'POST' }).catch(() => {});
    location.href = '/login.html';
  });
  showTab();
})();
