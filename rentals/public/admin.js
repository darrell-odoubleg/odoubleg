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
    if (!res.ok) throw Object.assign(new Error(out.error || 'Request failed'), { fields: out.fields });
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

  const emailLink = (r) => el('a', { href: `mailto:${encodeURIComponent(r.email).replace(/%40/, '@')}?subject=${encodeURIComponent(`Backline request ${r.ref}`)}` }, r.email);

  // Contact, show and gear for a request, or for the customer's saved original.
  const readView = (r) => [
    el('h3', {}, 'Contact'),
    el('dl', {},
      row('Name', r.name), row('Company', r.company), row('Email', emailLink(r)),
      row('Phone', el('a', { href: `tel:${r.phone.replace(/[^\d+]/g, '')}` }, r.phone))),
    el('h3', {}, 'Show'),
    el('dl', {},
      row('Event', r.event_name), row('Dates', span(r.start_date, r.end_date)), row('Artist', r.artist), row('Venue', r.venue),
      row('City', r.city_state), row('Getting gear', r.delivery)),
    r.notes ? [el('h3', {}, 'Notes'), el('p', { class: 'pre' }, r.notes)] : null,
    el('h3', {}, 'Gear'),
    r.items.length ? el('table', { class: 'pick' },
      el('thead', {}, el('tr', {}, el('th', {}, 'Qty'), el('th', {}, 'Item'), el('th', {}, 'Make or size'))),
      el('tbody', {}, r.items.map((i) => el('tr', {}, el('td', {}, String(i.qty)), el('td', {}, i.gear, i.category === 'Custom request' ? el('span', { class: 'tag' }, 'Custom') : null), el('td', {}, i.spec))))) : null,
  ].flat().filter(Boolean);

  const DELIVERY = ['Deliver to venue', 'Pick up', 'Not sure yet'];
  let dirty = false; // an open edit form has unsaved changes

  function renderRead(main, r, message) {
    dirty = false;
    const edit = el('button', { type: 'button', id: 'edit-details', class: 'btn-edit', onclick: () => renderEdit(main, r) }, 'Edit details');
    main.replaceChildren(...[
      el('div', { class: 'head-row' }, el('h2', {}, r.event_name), edit),
      el('p', { class: 'muted' }, `${r.ref}, received ${when(r.created_at)}${r.edited_at ? `, edited ${when(r.edited_at)}` : ''}`),
      message ? el('p', { class: 'muted', role: 'status', id: 'details-msg' }, message) : null,
      ...readView(r),
      r.original ? el('details', { class: 'original', id: 'original' },
        el('summary', {}, 'See what the customer originally sent'), ...readView({ ...r.original, ref: r.ref })) : null,
    ].filter(Boolean));
    return edit;
  }

  async function renderEdit(main, r) {
    const { items: products } = await api('/api/catalog');
    const input = (name, label, props = {}) => el('div', { class: 'field' },
      el('label', { htmlFor: `e-${name}` }, label),
      el(props.tag || 'input', { id: `e-${name}`, value: r[name] || '', ...(props.attrs || {}) }));
    const itemsBox = el('div', { id: 'e-items' });

    const addLine = (line = { gear: '', qty: 1, spec: '' }, focus = false) => {
      const gear = el('input', { class: 'e-gear', value: line.gear, maxLength: 200, 'aria-label': 'Item', placeholder: 'Item' });
      gear.setAttribute('list', 'e-gear-options');
      const qty = el('input', { class: 'e-qty', type: 'number', min: 1, max: 99, value: line.qty, 'aria-label': 'Quantity' });
      const spec = el('input', { class: 'e-spec spec', value: line.spec, maxLength: 500, 'aria-label': 'Make or size', placeholder: 'Make or size' });
      const rowEl = el('div', { class: 'edit-item' }, gear, qty,
        el('button', { type: 'button', class: 'x', 'aria-label': 'Remove item', onclick: () => { rowEl.remove(); dirty = true; $('e-add').focus(); } }, '×'), spec);
      itemsBox.append(rowEl);
      if (focus) gear.focus();
    };

    const err = el('p', { class: 'form-error', role: 'alert', hidden: true });
    const form = el('form', { id: 'edit-form', noValidate: true },
      el('h2', {}, 'Edit request'),
      el('p', { class: 'muted' }, r.original ? 'The customer\'s original stays saved.' : 'The customer\'s original will be saved so you can still see it.'),
      el('h3', {}, 'Contact'),
      el('div', { class: 'row' }, input('name', 'Name'), input('company', 'Company')),
      el('div', { class: 'row' }, input('email', 'Email', { attrs: { type: 'email' } }), input('phone', 'Phone', { attrs: { type: 'tel' } })),
      el('h3', {}, 'Show'),
      input('event_name', 'Event name'),
      input('artist', 'Artist'),
      el('div', { class: 'row' }, input('venue', 'Venue'), input('city_state', 'City and state')),
      el('div', { class: 'row' }, input('start_date', 'First day needed', { attrs: { type: 'date' } }), input('end_date', 'Last day needed', { attrs: { type: 'date' } })),
      el('div', { class: 'field' }, el('label', { htmlFor: 'e-delivery' }, 'Getting the gear'),
        el('select', { id: 'e-delivery' }, DELIVERY.map((d) => el('option', { value: d, selected: d === r.delivery }, d)))),
      input('notes', 'Notes', { tag: 'textarea', attrs: { rows: 3, maxLength: 3000 } }),
      el('h3', {}, 'Gear'),
      el('datalist', { id: 'e-gear-options' }, products.map((p) => el('option', { value: p.name }))),
      itemsBox,
      el('p', { class: 'err', id: 'e-items-err', hidden: true, tabIndex: -1 }),
      el('button', { type: 'button', id: 'e-add', class: 'btn btn-quiet add-line', onclick: () => { addLine(undefined, true); dirty = true; } }, 'Add an item'),
      err,
      el('div', { class: 'edit-actions' },
        el('button', { type: 'submit', class: 'btn btn-go' }, 'Save changes'),
        el('button', { type: 'button', id: 'e-cancel', class: 'btn btn-quiet', onclick: () => renderRead(main, r).focus() }, 'Cancel')));
    r.items.forEach((i) => addLine(i));
    form.addEventListener('input', () => { dirty = true; });

    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      form.querySelectorAll('.field .err').forEach((n) => n.remove());
      form.querySelectorAll('[aria-invalid]').forEach((n) => n.removeAttribute('aria-invalid'));
      err.hidden = true;
      $('e-items-err').hidden = true;
      const body = Object.fromEntries(['name', 'company', 'email', 'phone', 'event_name', 'artist', 'venue', 'city_state', 'start_date', 'end_date', 'delivery', 'notes'].map((f) => [f, $(`e-${f}`).value]));
      body.items = [...itemsBox.querySelectorAll('.edit-item')].map((n) => ({
        gear: n.querySelector('.e-gear').value, qty: Number(n.querySelector('.e-qty').value), spec: n.querySelector('.e-spec').value,
      }));
      try {
        const out = await api(`/api/admin/requests/${r.id}/details`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
        const fresh = await api(`/api/admin/requests/${r.id}`);
        await load();
        renderRead(main, fresh, out.changed ? 'Saved your changes.' : 'Nothing was changed.').focus();
        main.scrollIntoView({ block: 'nearest' });
      } catch (ex) {
        err.textContent = ex.message;
        err.hidden = false;
        const targets = [];
        Object.entries(ex.fields || {}).forEach(([name, message]) => {
          if (name === 'items') {
            $('e-items-err').textContent = message;
            $('e-items-err').hidden = false;
            targets.push($('e-items-err'));
            return;
          }
          const field = $(`e-${name}`);
          if (!field) return;
          field.setAttribute('aria-invalid', 'true');
          field.closest('.field').append(el('p', { class: 'err' }, message));
          targets.push(field);
        });
        targets.sort((x, y) => (x.compareDocumentPosition(y) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
        if (targets[0]) targets[0].focus();
      }
    });

    main.replaceChildren(form);
    main.scrollIntoView({ block: 'nearest' });
    $('e-name').focus({ preventScroll: true });
  }

  async function open(id) {
    if (dirty && !window.confirm('Discard your unsaved edits to this request?')) return;
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
    [status, notes].forEach((n) => n.addEventListener('input', () => { saved.textContent = ''; }));

    // The follow-up block sits outside main, so editing never touches unsaved private notes.
    const main = el('div', { id: 'detail-main' });
    renderRead(main, r);
    $('detail').replaceChildren(
      main,
      el('h3', {}, 'Your follow-up'),
      el('div', { class: 'field' }, el('label', { htmlFor: 'status' }, 'Status'), status),
      el('div', { class: 'field' }, el('label', { htmlFor: 'internal' }, 'Private notes'), notes),
      el('div', { class: 'save-row' }, save, saved));
    $('detail').hidden = false;
    if (window.matchMedia('(max-width: 860px)').matches) $('detail').scrollIntoView();
  }

  // Products --------------------------------------------------------------------
  const NEW_CATEGORY = '__new';
  let catalog = { categories: [], popular: [], items: [] };
  let editing = null; // the product open in the form, or null when adding

  function renderProducts() {
    const words = $('prod-search').value.toLowerCase().split(/\s+/).filter(Boolean);
    const match = (i) => words.every((w) => `${i.name} ${i.category} ${i.makes.join(' ')}`.toLowerCase().includes(w));
    $('prod-count').textContent = `${catalog.items.length} on the rentals page`;
    const groups = catalog.categories.map((cat) => {
      const rows = catalog.items.filter((i) => i.category === cat && match(i));
      if (!rows.length) return null;
      return el('section', { class: 'prod-group' }, el('h2', {}, cat), el('ul', {}, rows.map((i) => el('li', { class: editing && editing.id === i.id ? 'editing' : '' },
        el('div', {}, el('span', { class: 'gear-name' }, i.name), i.makes.length ? el('span', { class: 'gear-makes' }, i.makes.join(' · ')) : null),
        el('div', { class: 'prod-actions' },
          el('button', { type: 'button', class: 'btn-edit', 'aria-label': `Edit ${i.name}`, onclick: () => startEdit(i) }, 'Edit'),
          el('button', { type: 'button', class: 'btn-del', 'aria-label': `Delete ${i.name}`, onclick: () => del(i) }, 'Delete'))))));
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

  function clearForm() {
    editing = null;
    $('form-title').textContent = 'Add a product';
    $('add-submit').textContent = 'Add product';
    $('add-cancel').hidden = true;
    $('add-name').value = '';
    $('add-makes').value = '';
    $('add-new').value = '';
    $('add-popular').checked = false;
    $('add-err').hidden = true;
  }

  function startEdit(item) {
    editing = item;
    $('form-title').textContent = `Edit ${item.name}`;
    $('add-submit').textContent = 'Save changes';
    $('add-cancel').hidden = false;
    $('add-name').value = item.name;
    $('add-makes').value = item.makes.join(', ');
    $('add-new').value = '';
    $('add-category').value = item.category;
    $('add-new-wrap').hidden = true;
    $('add-popular').checked = catalog.popular.includes(item.id);
    $('add-err').hidden = true;
    $('add-ok').textContent = '';
    renderProducts();
    $('add-form').scrollIntoView({ block: 'nearest' });
    $('add-name').focus();
  }

  async function del(item) {
    if (!window.confirm(`Delete "${item.name}"? Customers won't see it anymore. Past requests keep it.`)) return;
    $('prod-msg').hidden = true;
    if (editing && editing.id === item.id) clearForm();
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
  $('add-cancel').addEventListener('click', () => {
    const was = editing;
    clearForm();
    renderProducts();
    const back = was && document.querySelector(`[aria-label="Edit ${CSS.escape(was.name)}"]`);
    if (back) back.focus(); else $('add-name').focus();
  });
  $('add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const isNew = $('add-category').value === NEW_CATEGORY;
    $('add-err').hidden = true;
    $('add-ok').textContent = '';
    try {
      const wasEditing = !!editing;
      const p = await api(wasEditing ? `/api/admin/products/${encodeURIComponent(editing.id)}` : '/api/admin/products', {
        method: wasEditing ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: $('add-name').value,
          category: isNew ? $('add-new').value : $('add-category').value,
          makes: $('add-makes').value,
          popular: $('add-popular').checked,
        }),
      });
      clearForm();
      await loadProducts();
      $('add-category').value = p.category;
      $('add-new-wrap').hidden = true;
      $('add-ok').textContent = wasEditing ? `Saved "${p.name}" under ${p.category}.` : `Added "${p.name}" under ${p.category}.`;
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
