const crypto = require('crypto');
const express = require('express');
const db = require('../db/init');
const { MODES, setSetting, budgetState, reserve } = require('./budget');

const ASSET_TYPES = ['stock', 'crypto'];
const PICK_ACTIONS = ['buy', 'watch', 'skip'];

function cleanSymbol(s) {
  return String(s || '').trim().toUpperCase().slice(0, 20);
}

function holdings() {
  return db.prepare(`
    SELECT symbol, asset_type,
           ROUND(SUM(COALESCE(filled_amount, amount)), 2) AS invested,
           SUM(filled_qty) AS qty,
           COUNT(*) AS orders,
           MAX(updated_at) AS last_buy
    FROM orders WHERE status = 'filled'
    GROUP BY symbol, asset_type ORDER BY invested DESC
  `).all();
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
    holdings: holdings(),
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
  if (!symbol || !ASSET_TYPES.includes(asset_type)) return res.status(400).json({ error: 'symbol and asset_type (stock|crypto) are required' });
  const out = reserve({ pick_id, symbol: cleanSymbol(symbol), asset_type, amount });
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
      avg_price = COALESCE(?, avg_price), error = COALESCE(?, error), updated_at = datetime('now')
    WHERE id = ?
  `).run(status, broker_order_id || null, filled_amount ?? null, filled_qty ?? null, avg_price ?? null, error || null, order.id);
  res.json({ ok: true, budget: budgetState() });
});

// ---- Dashboard API (session) -------------------------------------------

const dashboard = express.Router();

dashboard.get('/state', (req, res) => {
  res.json({
    budget: budgetState(),
    holdings: holdings(),
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
  const { mode, budget_total, max_order } = req.body || {};
  if (mode !== undefined) {
    if (!MODES.includes(mode)) return res.status(400).json({ error: 'Bad mode' });
    setSetting('mode', mode);
  }
  for (const [key, val] of [['budget_total', budget_total], ['max_order', max_order]]) {
    if (val === undefined) continue;
    const n = Number(val);
    if (!(n >= 0) || n > 100000) return res.status(400).json({ error: `Bad ${key}` });
    setSetting(key, Math.round(n * 100) / 100);
  }
  res.json({ ok: true, budget: budgetState() });
});

module.exports = { agent, dashboard };
