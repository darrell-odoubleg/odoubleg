(() => {
  const CART_KEY = 'rentals-cart-v1';
  const MAX_QTY = 99;
  const $ = (id) => document.getElementById(id);

  function el(tag, props, ...kids) {
    const n = document.createElement(tag);
    Object.entries(props || {}).forEach(([k, v]) => {
      if (k === 'class') n.className = v;
      else if (k === 'onclick') n.addEventListener('click', v);
      else if (k.startsWith('aria-') || k === 'list') n.setAttribute(k, v);
      else n[k] = v;
    });
    kids.flat().forEach((c) => c != null && n.append(c));
    return n;
  }

  let catalog = { categories: [], popular: [], items: [] };
  let byId = new Map();
  let cart = {}; // id -> { qty, spec }, plus { custom: true, name } for custom requests
  let activeChip = 'all';
  let lastRef = null;

  const loadCart = () => {
    try { return JSON.parse(localStorage.getItem(CART_KEY)) || {}; } catch { return {}; }
  };
  const saveCart = () => {
    try { localStorage.setItem(CART_KEY, JSON.stringify(cart)); } catch { /* private window: cart lasts until reload */ }
  };
  const countAll = () => Object.values(cart).reduce((n, l) => n + l.qty, 0);
  // A saved cart can hold a product that has since been deleted from the list.
  const lineIds = () => Object.keys(cart).filter((id) => cart[id].custom || byId.has(id));
  const lineName = (id) => (cart[id].custom ? cart[id].name : byId.get(id).name);

  // Quantity control -----------------------------------------------------------
  function setQty(id, qty, focus) {
    if (qty <= 0) delete cart[id];
    else cart[id] = { spec: '', ...cart[id], qty: Math.min(qty, MAX_QTY) };
    saveCart();
    renderRowControl(id, focus);
    renderSheet();
    if (!$('view-request').hidden) renderItems();
  }

  function stepper(id, name, focus) {
    const line = cart[id];
    if (!line) {
      const add = el('button', { type: 'button', class: 'btn-add', 'aria-label': `Add ${name}`, onclick: () => setQty(id, 1, 'plus') }, 'Add');
      if (focus) queueMicrotask(() => add.focus());
      return add;
    }
    const minus = el('button', { type: 'button', 'aria-label': `One fewer ${name}`, onclick: () => setQty(id, line.qty - 1, 'minus') }, '−');
    const plus = el('button', { type: 'button', 'aria-label': `One more ${name}`, disabled: line.qty >= MAX_QTY, onclick: () => setQty(id, line.qty + 1, 'plus') }, '+');
    if (focus === 'plus') queueMicrotask(() => plus.focus());
    if (focus === 'minus') queueMicrotask(() => minus.focus());
    return el('div', { class: 'stepper' }, minus, el('output', { 'aria-live': 'polite', 'aria-label': `${name} quantity` }, String(line.qty)), plus);
  }

  function renderRowControl(id, focus) {
    const slot = document.querySelector(`[data-control="${id}"]`);
    if (!slot) return;
    const item = byId.get(id);
    slot.replaceChildren(stepper(id, item.name, focus));
    slot.closest('.gear').classList.toggle('in-cart', !!cart[id]);
  }

  // Catalog ---------------------------------------------------------------------
  function gearRow(item) {
    const row = el('li', { class: 'gear' },
      el('div', { class: 'gear-text' },
        el('span', { class: 'gear-name' }, item.name),
        item.makes.length ? el('span', { class: 'gear-makes' }, item.makes.join(' · ')) : null),
      el('div', { class: 'gear-control' }));
    row.querySelector('.gear-control').dataset.control = item.id;
    row.dataset.id = item.id;
    row.dataset.search = `${item.name} ${item.category} ${item.makes.join(' ')}`.toLowerCase();
    return row;
  }

  function buildCatalog() {
    const groups = $('groups');
    groups.replaceChildren(...catalog.categories.map((cat) => el('section', { class: 'group' },
      el('h2', {}, cat),
      el('ul', { class: 'gear-list' }, catalog.items.filter((i) => i.category === cat).map(gearRow)))
    ));
    groups.querySelectorAll('section').forEach((s, i) => { s.dataset.cat = catalog.categories[i]; });
    catalog.items.forEach((i) => renderRowControl(i.id));

    const chip = (key, label) => {
      const b = el('button', { type: 'button', class: 'chip', 'aria-pressed': String(key === activeChip), onclick: () => setChip(key) }, label);
      b.dataset.key = key;
      return b;
    };
    $('chips').replaceChildren(chip('all', 'All gear'), chip('popular', 'Most requested'),
      ...catalog.categories.map((c) => chip(c, c)), chip('custom', 'Custom request'));
  }

  function setChip(key) {
    activeChip = key;
    document.querySelectorAll('.chip').forEach((c) => c.setAttribute('aria-pressed', String(c.dataset.key === key)));
    applyFilter();
  }

  function showCustom() {
    setChip('custom');
    $('custom').scrollIntoView({ block: 'start' });
    $('custom-name').focus({ preventScroll: true });
  }

  function addCustom(e) {
    e.preventDefault();
    const name = $('custom-name').value.trim();
    const qty = Number($('custom-qty').value);
    const err = $('custom-err');
    $('custom-ok').textContent = '';
    err.hidden = true;
    if (!name) {
      err.textContent = 'Tell us what you need.';
      err.hidden = false;
      $('custom-name').focus();
      return;
    }
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) {
      err.textContent = `Enter a quantity from 1 to ${MAX_QTY}.`;
      err.hidden = false;
      $('custom-qty').focus();
      return;
    }
    cart[`custom-${Date.now()}`] = { custom: true, name, qty, spec: $('custom-details').value.trim() };
    saveCart();
    renderSheet();
    $('custom-form').reset();
    $('custom-ok').textContent = `Added "${name}" to your request.`;
    $('custom-name').focus();
  }

  function applyFilter() {
    const words = $('search').value.toLowerCase().split(/\s+/).filter(Boolean);
    const popular = new Set(catalog.popular);
    let shown = 0;
    $('custom').hidden = activeChip !== 'all' && activeChip !== 'custom';
    document.querySelectorAll('.group').forEach((group) => {
      let inGroup = 0;
      group.querySelectorAll('.gear').forEach((row) => {
        const chipOk = activeChip === 'all' || (activeChip === 'popular' ? popular.has(row.dataset.id) : group.dataset.cat === activeChip);
        const ok = chipOk && words.every((w) => row.dataset.search.includes(w));
        row.hidden = !ok;
        if (ok) inGroup++;
      });
      group.hidden = !inGroup;
      shown += inGroup;
    });
    $('no-match').hidden = shown > 0 || activeChip === 'custom';
  }

  // Sidebar and phone bar -------------------------------------------------------
  function renderSheet() {
    const ids = lineIds();
    $('sheet-empty').hidden = ids.length > 0;
    $('sheet-go').hidden = ids.length === 0;
    $('sheet-list').replaceChildren(...ids.map((id) => el('li', {},
      el('span', { class: 'qty' }, `${cart[id].qty} ×`),
      el('span', { class: 'nm' }, lineName(id), cart[id].custom ? el('span', { class: 'tag' }, 'Custom') : null),
      el('button', { type: 'button', class: 'x', 'aria-label': `Remove ${lineName(id)}`, onclick: () => setQty(id, 0) }, '×'))));
    const n = countAll();
    $('mobile-bar').hidden = n === 0;
    $('mobile-count').textContent = `${n} item${n === 1 ? '' : 's'}`;
  }

  // Review ----------------------------------------------------------------------
  function renderItems() {
    const ids = lineIds();
    $('items-empty').hidden = ids.length > 0;
    // The list is rebuilt on every quantity change, so put focus back on the same button.
    const focused = document.activeElement && document.activeElement.getAttribute('aria-label');
    $('items').replaceChildren(...ids.map((id) => {
      const line = cart[id];
      const name = lineName(id);
      const makes = line.custom ? [] : byId.get(id).makes;
      const listId = `makes-${id}`;
      const spec = el('input', {
        type: 'text', class: 'spec', value: line.spec, maxLength: line.custom ? 500 : 200,
        placeholder: 'Make, model or size (optional)', 'aria-label': `${name}: make, model or size`,
        ...(makes.length ? { list: listId } : {}),
      });
      spec.addEventListener('input', () => { line.spec = spec.value; saveCart(); });
      return el('li', { class: 'item' },
        el('div', { class: 'item-top' },
          el('span', { class: 'gear-name' }, name, line.custom ? el('span', { class: 'tag' }, 'Custom') : null),
          el('div', { class: 'stepper' },
            el('button', { type: 'button', 'aria-label': `One fewer ${name}`, onclick: () => setQty(id, line.qty - 1) }, '−'),
            el('output', {}, String(line.qty)),
            el('button', { type: 'button', 'aria-label': `One more ${name}`, disabled: line.qty >= MAX_QTY, onclick: () => setQty(id, line.qty + 1) }, '+'))),
        spec,
        makes.length ? el('datalist', { id: listId }, makes.map((m) => el('option', { value: m }))) : null);
    }));
    if (focused) {
      const again = [...$('items').querySelectorAll('[aria-label]')].find((n) => n.getAttribute('aria-label') === focused);
      if (again) again.focus();
    }
  }

  // Sending ---------------------------------------------------------------------
  function clearErrors() {
    document.querySelectorAll('.field .err').forEach((n) => n.remove());
    document.querySelectorAll('[aria-invalid]').forEach((n) => n.removeAttribute('aria-invalid'));
    $('err-items').hidden = true;
    $('form-error').hidden = true;
  }

  function showErrors(fields) {
    const targets = [];
    Object.entries(fields).forEach(([name, message]) => {
      if (name === 'items') {
        $('err-items').textContent = message;
        $('err-items').hidden = false;
        targets.push($('err-items'));
        return;
      }
      if (name === 'delivery') {
        $('delivery-field').append(el('p', { class: 'err' }, message));
        targets.push(document.querySelector('input[name=delivery]'));
        return;
      }
      const input = $(name);
      if (!input) return;
      input.setAttribute('aria-invalid', 'true');
      input.closest('.field').append(el('p', { class: 'err' }, message));
      targets.push(input);
    });
    // Land on the problem nearest the top of the page.
    targets.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    if (targets[0]) targets[0].focus();
  }

  async function submit(e) {
    e.preventDefault();
    clearErrors();
    const send = $('send');
    const form = $('form');
    const data = Object.fromEntries(new FormData(form).entries());
    data.items = lineIds().map((id) => {
      const l = cart[id];
      return l.custom ? { custom: true, name: l.name, qty: l.qty, spec: l.spec } : { id, qty: l.qty, spec: l.spec };
    });
    send.disabled = true;
    send.textContent = 'Sending…';
    try {
      const res = await fetch('/api/requests', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
      const out = await res.json().catch(() => ({}));
      if (!res.ok) {
        $('form-error').textContent = out.error || 'That didn\'t go through. Please try again.';
        $('form-error').hidden = false;
        if (out.fields) showErrors(out.fields);
        return;
      }
      lastRef = out.ref;
      cart = {};
      saveCart();
      form.reset();
      catalog.items.forEach((i) => renderRowControl(i.id));
      renderSheet();
      location.hash = '#sent';
    } catch {
      $('form-error').textContent = 'We couldn\'t reach the server, so your request wasn\'t sent. Check your connection and try again.';
      $('form-error').hidden = false;
    } finally {
      send.disabled = false;
      send.textContent = 'Send request';
    }
  }

  // Views -----------------------------------------------------------------------
  function route() {
    const hash = location.hash;
    const sent = hash === '#sent' && lastRef;
    const review = hash === '#request';
    $('view-catalog').hidden = sent || review;
    $('view-request').hidden = !review;
    $('view-done').hidden = !sent;
    if (review) renderItems();
    if (sent) {
      $('done-ref').textContent = lastRef;
      document.querySelector('#view-done h1').focus();
    }
    if (hash === '#custom' && catalog.items.length) showCustom();
    else window.scrollTo(0, 0);
  }

  async function start() {
    $('form').addEventListener('submit', submit);
    $('search').addEventListener('input', () => { if (activeChip === 'custom') setChip('all'); else applyFilter(); });
    $('custom-link').addEventListener('click', showCustom);
    $('custom-form').addEventListener('submit', addCustom);
    $('custom-form').addEventListener('input', () => { $('custom-err').hidden = true; $('custom-ok').textContent = ''; });
    window.addEventListener('hashchange', route);
    route();
    try {
      const res = await fetch('/api/catalog');
      if (!res.ok) throw new Error();
      catalog = await res.json();
    } catch {
      $('load-state').textContent = 'The gear list didn\'t load. Please refresh the page.';
      return;
    }
    byId = new Map(catalog.items.map((i) => [i.id, i]));
    const saved = loadCart();
    cart = Object.fromEntries(Object.entries(saved).filter(([id, l]) => l && l.qty >= 1 && (l.custom ? l.name : byId.has(id))));
    $('load-state').hidden = true;
    buildCatalog();
    renderSheet();
    route();
  }
  start();
})();
