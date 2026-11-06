// npm test: runs the server on a throwaway database and checks intake + inbox.
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const assert = require('assert');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rentals-smoke-'));
const PORT = 4899;
const base = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, PORT, NODE_ENV: 'test', SESSION_SECRET: 'smoke', DB_PATH: path.join(dir, 't.db'), NOTIFY_TO: '' }; // no real alerts from tests

const future = (d) => new Date(Date.now() + d * 864e5).toISOString().slice(0, 10);
const good = {
  name: 'Test Buyer', email: 'buyer@example.com', phone: '555-010-2000', event_name: 'Test Fair',
  city_state: 'Billings, MT', start_date: future(30), end_date: future(31), delivery: 'Pick up',
  items: [{ id: 'drum-kit', qty: 1, spec: 'DW' }, { id: 'guitar-amp', qty: 2, spec: '' }],
};
const post = (url, body, headers) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });

(async () => {
  const srv = spawn('node', ['server/index.js'], { cwd: path.join(__dirname, '..'), env, stdio: 'inherit' });
  try {
    for (let i = 0; i < 40; i++) {
      try { await fetch(`${base}/api/catalog`); break; } catch { await new Promise((r) => setTimeout(r, 100)); }
    }
    const cat = await (await fetch(`${base}/api/catalog`)).json();
    assert(cat.items.length > 100 && cat.items.every((i) => Object.keys(i).join() === 'id,name,category,makes'), 'catalog holds gear fields only');

    let r = await post('/api/requests', { ...good, email: 'nope', end_date: future(1), items: [] });
    let out = await r.json();
    assert.equal(r.status, 400);
    assert(out.fields.email && out.fields.end_date && out.fields.items, 'field errors returned');

    r = await post('/api/requests', { ...good, items: [{ id: 'not-gear', qty: 1 }] });
    assert.equal(r.status, 400, 'unknown gear refused');
    r = await post('/api/requests', { ...good, items: [{ id: 'drum-kit', qty: 1000 }] });
    assert.equal(r.status, 400, 'absurd quantity refused');

    r = await post('/api/requests', { ...good, name: '<img src=x onerror=alert(1)>' });
    out = await r.json();
    assert.equal(r.status, 201);
    assert(/^R-[A-Z2-9]{6}$/.test(out.ref));

    r = await post('/api/requests', { ...good, items: [] });
    assert.equal(r.status, 400, 'empty request refused');
    r = await post('/api/requests', { ...good, items: [{ custom: true, name: '   ', qty: 1 }] });
    assert.equal(r.status, 400, 'blank custom request refused');
    r = await post('/api/requests', { ...good, items: [{ custom: true, name: 'A theremin', qty: 2, spec: 'Moog' }] });
    assert.equal(r.status, 201, 'custom-only request accepted');

    r = await post('/api/requests', { ...good, website: 'http://spam.example' });
    assert.equal((await r.json()).ref, 'R-RECEIVED', 'honeypot looks like success');

    // Inbox is private.
    assert.equal((await fetch(`${base}/api/admin/requests`)).status, 401);
    assert.equal((await fetch(`${base}/admin`, { redirect: 'manual' })).status, 302);
    assert.equal((await fetch(`${base}/admin.html`)).status, 404, 'inbox page not served statically');
    assert.equal((await post('/api/login', { email: 'nobody@example.com', password: 'x' })).status, 401);

    await new Promise((res, rej) => spawn('node', ['scripts/user.js', 'a@example.com', 'A', 'pw-for-smoke'], { cwd: path.join(__dirname, '..'), env, stdio: 'ignore' }).on('exit', (c) => (c ? rej(new Error('user.js')) : res())));
    r = await post('/api/login', { email: 'a@example.com', password: 'pw-for-smoke' });
    assert.equal(r.status, 200);
    const cookie = r.headers.get('set-cookie').split(';')[0];
    const list = await (await fetch(`${base}/api/admin/requests`, { headers: { cookie } })).json();
    assert.equal(list.requests.length, 2, 'honeypot submission not saved');
    const one = list.requests.find((x) => x.item_count === 3);
    const full = await (await fetch(`${base}/api/admin/requests/${one.id}`, { headers: { cookie } })).json();
    assert.equal(full.items[0].gear, 'Drum kit');
    r = await fetch(`${base}/api/admin/requests/${one.id}`, { method: 'PUT', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'Quoted', internal_notes: 'called' }) });
    assert.equal(r.status, 200);
    r = await fetch(`${base}/api/admin/requests/${one.id}`, { method: 'PUT', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'Bogus' }) });
    assert.equal(r.status, 400);

    const custom = list.requests.find((x) => x.item_count === 2);
    const customFull = await (await fetch(`${base}/api/admin/requests/${custom.id}`, { headers: { cookie } })).json();
    assert.deepEqual(customFull.items[0], { gear: 'A theremin', category: 'Custom request', qty: 2, spec: 'Moog' });

    // Products
    const authed = (body) => ({ method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await post('/api/admin/products', { name: 'X', category: 'Drums' })).status, 401, 'adding needs a login');
    assert.equal((await fetch(`${base}/api/admin/products/drum-kit`, { method: 'DELETE' })).status, 401, 'deleting needs a login');
    assert.equal((await fetch(`${base}/api/admin/products`, authed({ name: '', category: 'Drums' }))).status, 400);
    assert.equal((await fetch(`${base}/api/admin/products`, authed({ name: 'drum KIT', category: 'Drums' }))).status, 409, 'duplicate refused');
    r = await fetch(`${base}/api/admin/products`, authed({ name: 'Test Gizmo', category: 'drums', makes: 'Acme, Acme, Zed' }));
    assert.equal(r.status, 201);
    const gizmo = await r.json();
    assert.deepEqual([gizmo.category, gizmo.makes], ['Drums', ['Acme', 'Zed']], 'joins existing category, makes deduped');
    const after = await (await fetch(`${base}/api/catalog`)).json();
    assert(after.items.some((i) => i.id === gizmo.id), 'new product is public');
    assert.equal(after.categories.filter((c) => c.toLowerCase() === 'drums').length, 1);
    r = await post('/api/requests', { ...good, items: [{ id: gizmo.id, qty: 1 }] });
    assert.equal(r.status, 201, 'new product can be requested');
    const gizmoReq = (await (await fetch(`${base}/api/admin/requests`, { headers: { cookie } })).json()).requests[0];

    assert.equal((await fetch(`${base}/api/admin/products/${gizmo.id}`, { method: 'DELETE', headers: { cookie } })).status, 200);
    assert.equal((await fetch(`${base}/api/admin/products/${gizmo.id}`, { method: 'DELETE', headers: { cookie } })).status, 404);
    assert.equal((await post('/api/requests', { ...good, items: [{ id: gizmo.id, qty: 1 }] })).status, 400, 'deleted product refused');
    const kept = await (await fetch(`${base}/api/admin/requests/${gizmoReq.id}`, { headers: { cookie } })).json();
    assert.equal(kept.items[0].gear, 'Test Gizmo', 'past request keeps a deleted product');

    // A deleted seed product must not come back when the app restarts.
    assert.equal((await fetch(`${base}/api/admin/products/snare-drum`, { method: 'DELETE', headers: { cookie } })).status, 200);
    const reread = execFileSync('node', ['-e', "console.log(require('./server/products').get('snare-drum'))"], { cwd: path.join(__dirname, '..'), env }).toString().trim();
    assert.equal(reread, 'null', 'deleted product stays deleted');

    // Editing
    const put = (id, body, headers = { cookie }) => fetch(`${base}/api/admin/products/${id}`, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const edit = { name: 'Drum kit, 5 piece', category: 'Drums', makes: 'DW, Gretsch', popular: true };
    assert.equal((await put('drum-kit', edit, {})).status, 401, 'editing needs a login');
    assert.equal((await put('no-such-item', edit)).status, 404);
    assert.equal((await put('drum-kit', { ...edit, name: '' })).status, 400);
    assert.equal((await put('drum-kit', { ...edit, name: 'kick DRUM' })).status, 409, 'cannot rename onto another product');
    assert.equal((await put('drum-kit', { ...edit, name: 'Drum Kit' })).status, 200, 'can change only the capitals of its own name');
    r = await put('drum-kit', edit);
    assert.deepEqual(await r.json(), { id: 'drum-kit', name: 'Drum kit, 5 piece', category: 'Drums', makes: ['DW', 'Gretsch'] });
    let now = await (await fetch(`${base}/api/catalog`)).json();
    assert(now.popular.includes('drum-kit'));
    const before = now.categories.join();
    const place = now.items.findIndex((i) => i.id === 'kick-drum');
    await put('kick-drum', { name: 'Kick drum', category: 'Drums', makes: 'DW' });
    now = await (await fetch(`${base}/api/catalog`)).json();
    assert.equal(now.items.findIndex((i) => i.id === 'kick-drum'), place, 'rename keeps its place');
    assert.equal((await put('drum-kit', { ...edit, category: 'other', popular: false })).status, 200);
    now = await (await fetch(`${base}/api/catalog`)).json();
    assert.equal(now.categories.join(), before, 'moving the first item does not reorder categories');
    assert.equal(now.items.find((i) => i.id === 'drum-kit').category, 'Other', 'joins existing category');
    assert(!now.popular.includes('drum-kit'));

    // Rate limit: 3 saved already, limit is 6 per hour.
    for (let i = 0; i < 3; i++) assert.equal((await post('/api/requests', good)).status, 201);
    assert.equal((await post('/api/requests', good)).status, 429, 'rate limit applies');
    console.log('smoke ok');
  } finally {
    srv.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
