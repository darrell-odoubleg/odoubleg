const db = require('../db/init');

const MODES = ['dry_run', 'live', 'paused'];

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return {
    mode: s.mode,
    budget_total: Number(s.budget_total),
    max_order: Number(s.max_order),
  };
}

function setSetting(key, value) {
  db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(String(value), key);
}

// Real money committed: filled orders at their filled amount, in-flight
// orders at their reserved amount. Failed/released orders free their money.
function committed(paper) {
  const statuses = paper ? "('dry_run')" : "('reserved', 'placed', 'filled')";
  const row = db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN status = 'filled' THEN COALESCE(filled_amount, amount) ELSE amount END), 0) AS total
    FROM orders WHERE status IN ${statuses}
  `).get();
  return Math.round(row.total * 100) / 100;
}

function budgetState() {
  const s = getSettings();
  const paper = s.mode === 'dry_run';
  const used = committed(paper);
  return {
    ...s,
    committed: used,
    remaining: Math.max(0, Math.round((s.budget_total - used) * 100) / 100),
    paper_committed: committed(true),
    live_committed: committed(false),
  };
}

// Checked and recorded in one transaction so two reservations can't both
// squeeze under the cap.
const reserve = db.transaction(({ pick_id, symbol, asset_type, amount }) => {
  const s = budgetState();
  if (s.mode === 'paused') return { ok: false, error: 'Trading is paused' };
  if (!(amount > 0)) return { ok: false, error: 'Amount must be greater than 0' };
  if (amount > s.max_order) return { ok: false, error: `Amount exceeds the $${s.max_order} per-order cap` };
  if (amount > s.remaining) return { ok: false, error: `Amount exceeds the $${s.remaining} remaining budget` };

  const status = s.mode === 'live' ? 'reserved' : 'dry_run';
  const info = db.prepare(`
    INSERT INTO orders (pick_id, symbol, asset_type, amount, status) VALUES (?, ?, ?, ?, ?)
  `).run(pick_id || null, symbol, asset_type, amount, status);

  return {
    ok: true,
    order_id: info.lastInsertRowid,
    mode: s.mode,
    place_order: s.mode === 'live',
    remaining_after: Math.round((s.remaining - amount) * 100) / 100,
  };
});

module.exports = { MODES, getSettings, setSetting, budgetState, reserve };
