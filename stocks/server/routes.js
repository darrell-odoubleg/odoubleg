const crypto = require('crypto');
const express = require('express');
const db = require('../db/init');
const { MODES, NUMERIC, setSetting, budgetState, lots, reserve } = require('./budget');

const ASSET_TYPES = ['stock', 'crypto'];
const PICK_ACTIONS = ['buy', 'watch', 'skip'];
const SELL_REASONS = ['stop_loss', 'take_profit', 'signal'];
const PROTECTION = ['broker_trailing', 'broker_stop', 'hourly_check'];

function cleanSymbol(s) {
  return String(s || '').trim().toUpperCase().slice(0, 20);
}

function positions() {
  return [...lots('live', { open: true }), ...lots('paper', { open: true })];
}

function sellHistory(limit) {
  return db.prepare(`
    SELECT sl.*, o.symbol, o.asset_type, COALESCE(o.filled_amount, o.amount) AS cost, o.avg_price AS entry_price,
           o.status = 'dry_run' AS paper,
           CASE WHEN sl.proceeds IS NOT NULL THEN ROUND(sl.proceeds - COALESCE(o.filled_amount, o.amount), 2) END AS pnl
    FROM sells sl JOIN orders o ON o.id = sl.lot_id
    ORDER BY sl.id DESC LIMIT ?
  `).all(limit);
}

function recentPicks(limit) {
  return db.prepare(`
    SELECT p.*, o.id AS order_id, o.status AS order_status
    FROM picks p LEFT JOIN orders o ON o.pick_id = p.id
    ORDER BY p.id DESC LIMIT ?
  `).all(limit);
}

// ---- Routine API (bearer token) ----------------------------------------

const agent = express.Router();

agent.use((req, res, next) => {
  const expected = Buffer.from(process.env.AGENT_TOKEN || '');
  const given = Buffer.from((req.get('authorization') || '').replace(/^Bearer\s+/i, ''));
  if (expected.length && given.length === expected.length && crypto.timingSafeEqual(given, expected)) return next();
  return res.status(401).json({ error: 'Bad agent token' });
});

agent.get('/state', (req, res) => {
  res.json({
    budget: budgetState(),
    positions: positions(),
    pending_sells: db.prepare("SELECT * FROM sells WHERE status = 'placed' ORDER BY id").all(),
    open_orders: db.prepare("SELECT * FROM orders WHERE status IN ('reserved', 'placed') ORDER BY id").all(),
    recent_picks: recentPicks(30).map(({ reasoning, ...p }) => ({ ...p, reasoning: reasoning.slice(0, 300) })),
  });
});

// Log a run and every symbol considered. Returns pick ids for reservations.
agent.post('/runs', (req, res) => {
  const { summary, picks } = req.body || {};
  if (!summary || !Array.isArray(picks)) return res.status(400).json({ error: 'summary and picks[] are required' });
  for (const p of picks) {
    if (!p.symbol || !ASSET_TYPES.includes(p.asset_type) || !PICK_ACTIONS.includes(p.action) || !p.reasoning) {
      return res.status(400).json({ error: 'Each pick needs symbol, asset_type (stock|crypto), action (buy|watch|skip), reasoning' });
    }
  }
  const { mode } = budgetState();
  const insertPick = db.prepare(`
    INSERT INTO picks (run_id, symbol, asset_type, action, conviction, amount, price, reasoning)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = db.transaction(() => {
    const runId = db.prepare('INSERT INTO runs (mode, summary) VALUES (?, ?)').run(mode, String(summary)).lastInsertRowid;
    const ids = picks.map((p) => ({
      symbol: cleanSymbol(p.symbol),
      action: p.action,
      pick_id: insertPick.run(
        runId, cleanSymbol(p.symbol), p.asset_type, p.action,
        Number.isFinite(p.conviction) ? p.conviction : null,
        Number.isFinite(p.amount) ? p.amount : null,
        Number.isFinite(p.price) ? p.price : null,
        String(p.reasoning),
      ).lastInsertRowid,
    }));
    return { run_id: runId, picks: ids };
  })();
  res.json({ ok: true, mode, ...result });
});

// Ask permission to spend. Refused if paused or over a cap.
agent.post('/reserve', (req, res) => {
  const { pick_id, symbol, asset_type } = req.body || {};
  const amount = Math.round(Number(req.body && req.body.amount) * 100) / 100;
  const price = Number(req.body && req.body.price);
  if (!symbol || !ASSET_TYPES.includes(asset_type)) return res.status(400).json({ error: 'symbol and asset_type (stock|crypto) are required' });
  const out = reserve({ pick_id, symbol: cleanSymbol(symbol), asset_type, amount, price });
  res.status(out.ok ? 200 : 409).json(out);
});

// Report what happened to a reserved order.
const NEXT_STATUS = { reserved: ['placed', 'filled', 'failed', 'released'], placed: ['filled', 'failed', 'released'] };

agent.post('/orders/:id', (req, res) => {
  const order = db.prepare('SELECT * FROM orders WHERE id = ?').get(req.params.id);
  if (!order) return res.status(404).json({ error: 'No such order' });
  const { status, broker_order_id, filled_amount, filled_qty, avg_price, error } = req.body || {};
  if (!(NEXT_STATUS[order.status] || []).includes(status)) {
    return res.status(409).json({ error: `Can't move a ${order.status} order to ${status}` });
  }
  if (filled_amount != null && Number(filled_amount) > order.amount + 1) {
    return res.status(409).json({ error: `filled_amount is more than the $${order.amount} reserved` });
  }
  db.prepare(`
    UPDATE orders SET status = ?, broker_order_id = COALESCE(?, broker_order_id),
      filled_amount = COALESCE(?, filled_amount), filled_qty = COALESCE(?, filled_qty),
      avg_price = COALESCE(?, avg_price), error = COALESCE(?, error), updated_at = datetime('now'),
      high_water = CASE WHEN ? = 'filled' THEN COALESCE(high_water, ?) ELSE high_water END
    WHERE id = ?
  `).run(status, broker_order_id || null, filled_amount ?? null, filled_qty ?? null, avg_price ?? null, error || null,
    status, avg_price ?? null, order.id);
  res.json({ ok: true, budget: budgetState() });
});

// Update exit tracking on an open lot. high_water only ever moves up.
agent.post('/lots/:id', (req, res) => {
  const lot = db.prepare("SELECT * FROM orders WHERE id = ? AND status IN ('filled', 'dry_run')").get(req.params.id);
  if (!lot) return res.status(404).json({ error: 'No such lot' });
  const { high_water, stop_order_id, protection } = req.body || {};
  if (protection !== undefined && !PROTECTION.includes(protection)) {
    return res.status(400).json({ error: `protection must be one of ${PROTECTION.join(', ')}` });
  }
  const hw = Number(high_water);
  db.prepare(`
    UPDATE orders SET
      high_water = CASE WHEN ? > COALESCE(high_water, 0) THEN ? ELSE high_water END,
      stop_order_id = CASE WHEN ? THEN ? ELSE stop_order_id END,
      protection = COALESCE(?, protection), updated_at = datetime('now')
    WHERE id = ?
  `).run(Number.isFinite(hw) ? hw : 0, Number.isFinite(hw) ? hw : 0,
    stop_order_id !== undefined ? 1 : 0, stop_order_id || null, protection || null, lot.id);
  res.json({ ok: true, lot: lots(lot.status === 'dry_run' ? 'paper' : 'live').find((l) => l.id === lot.id) });
});

// Sell a whole lot. Only lots the routine bought can be sold, once each.
// Paper lots sell instantly at the quoted price.
agent.post('/sells', (req, res) => {
  const { lot_id, reason, reasoning, status, broker_order_id, error } = req.body || {};
  const price = Number(req.body && req.body.price);
  const out = db.transaction(() => {
    const lot = db.prepare("SELECT * FROM orders WHERE id = ? AND status IN ('filled', 'dry_run')").get(lot_id);
    if (!lot) return [404, { error: 'No such lot — only lots bought by this routine can be sold' }];
    if (!SELL_REASONS.includes(reason)) return [400, { error: `reason must be one of ${SELL_REASONS.join(', ')}` }];
    if (!reasoning) return [400, { error: 'reasoning is required' }];
    const active = db.prepare("SELECT id FROM sells WHERE lot_id = ? AND status IN ('placed', 'filled', 'dry_run')").get(lot.id);
    if (active) return [409, { error: `Lot ${lot.id} already has sell ${active.id}` }];

    if (lot.status === 'dry_run') {
      if (!(price > 0)) return [400, { error: 'price is required' }];
      const id = db.prepare(`
        INSERT INTO sells (lot_id, reason, status, reasoning, qty, avg_price, proceeds)
        VALUES (?, ?, 'dry_run', ?, ?, ?, ?)
      `).run(lot.id, reason, String(reasoning), lot.filled_qty, price, Math.round(lot.filled_qty * price * 100) / 100).lastInsertRowid;
      return [200, { ok: true, sell_id: id, paper: true }];
    }

    if (!['placed', 'filled', 'failed'].includes(status)) return [400, { error: 'status must be placed, filled or failed for a live lot' }];
    const proceeds = req.body.proceeds != null ? Number(req.body.proceeds) : null;
    if (status === 'filled' && !(proceeds >= 0)) return [400, { error: 'proceeds are required for a filled sell' }];
    const id = db.prepare(`
      INSERT INTO sells (lot_id, reason, status, reasoning, broker_order_id, qty, avg_price, proceeds, error)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(lot.id, reason, status, String(reasoning), broker_order_id || null, req.body.qty ?? lot.filled_qty,
      price > 0 ? price : null, proceeds, error || null).lastInsertRowid;
    return [200, { ok: true, sell_id: id, paper: false }];
  })();
  res.status(out[0]).json(out[1]);
});

// Report what happened to a placed live sell.
agent.post('/sells/:id', (req, res) => {
  const sell = db.prepare('SELECT * FROM sells WHERE id = ?').get(req.params.id);
  if (!sell) return res.status(404).json({ error: 'No such sell' });
  const { status, proceeds, avg_price, error } = req.body || {};
  if (sell.status !== 'placed' || !['filled', 'failed'].includes(status)) {
    return res.status(409).json({ error: `Can't move a ${sell.status} sell to ${status}` });
  }
  if (status === 'filled' && !(Number(proceeds) >= 0)) return res.status(400).json({ error: 'proceeds are required' });
  db.prepare(`
    UPDATE sells SET status = ?, proceeds = COALESCE(?, proceeds), avg_price = COALESCE(?, avg_price),
      error = COALESCE(?, error), updated_at = datetime('now') WHERE id = ?
  `).run(status, proceeds ?? null, avg_price ?? null, error || null, sell.id);
  res.json({ ok: true, budget: budgetState() });
});

// ---- Dashboard API (session) -------------------------------------------

const dashboard = express.Router();

dashboard.get('/state', (req, res) => {
  res.json({
    budget: budgetState(),
    positions: positions(),
    sells: sellHistory(200),
    orders: db.prepare('SELECT * FROM orders ORDER BY id DESC LIMIT 200').all(),
  });
});

dashboard.get('/runs', (req, res) => {
  const runs = db.prepare('SELECT * FROM runs ORDER BY id DESC LIMIT 50').all();
  const picksFor = db.prepare(`
    SELECT p.*, o.status AS order_status, o.amount AS order_amount
    FROM picks p LEFT JOIN orders o ON o.pick_id = p.id
    WHERE p.run_id = ? ORDER BY CASE p.action WHEN 'buy' THEN 0 WHEN 'watch' THEN 1 ELSE 2 END, p.conviction DESC
  `);
  res.json(runs.map((r) => ({ ...r, picks: picksFor.all(r.id) })));
});

dashboard.post('/settings', (req, res) => {
  const { mode } = req.body || {};
  if (mode !== undefined) {
    if (!MODES.includes(mode)) return res.status(400).json({ error: 'Bad mode' });
    setSetting('mode', mode);
  }
  for (const key of NUMERIC) {
    const val = req.body[key];
    if (val === undefined) continue;
    const n = Number(val);
    const max = key.endsWith('_pct') ? 90 : 100000;
    if (!(n >= 0) || n > max || (key.endsWith('_pct') && n < 1)) return res.status(400).json({ error: `Bad ${key}` });
    setSetting(key, Math.round(n * 100) / 100);
  }
  res.json({ ok: true, budget: budgetState() });
});

module.exports = { agent, dashboard };
