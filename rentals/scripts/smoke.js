// npm test: runs the server on a throwaway database and checks intake + inbox.
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
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

    r = await post('/api/requests', { ...good, items: [], other_gear: 'A theremin' });
    assert.equal(r.status, 201, 'free-text only request accepted');

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

    // Rate limit: 2 saved already, limit is 6 per hour.
    for (let i = 0; i < 4; i++) assert.equal((await post('/api/requests', good)).status, 201);
    assert.equal((await post('/api/requests', good)).status, 429, 'rate limit applies');
    console.log('smoke ok');
  } finally {
    srv.kill();
    fs.rmSync(dir, { recursive: true, force: true });
  }
})().catch((e) => { console.error(e); process.exitCode = 1; });
