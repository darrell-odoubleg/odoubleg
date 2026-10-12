const db = require('../db/init');

const MODES = ['dry_run', 'live', 'paused'];
const NUMERIC = ['budget_total', 'max_order', 'stop_loss_pct', 'take_profit_pct'];
const FLAGS = ['crypto_enabled'];

const round2 = (n) => Math.round(n * 100) / 100;

function getSettings() {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const s = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  const out = { mode: s.mode };
  for (const k of NUMERIC) out[k] = Number(s[k]);
  for (const k of FLAGS) out[k] = s[k] === '1';
  return out;
}

function setSetting(key, value) {
  db.prepare('UPDATE settings SET value = ? WHERE key = ?').run(String(value), key);
}

// A lot is a filled buy (status 'filled') or a paper buy (status 'dry_run').
// It's closed once a sell for it is placed, filled or paper-filled.
const LOT_STATUS = { live: 'filled', paper: 'dry_run' };
const SELL_DONE = { live: "('filled')", paper: "('dry_run')" };

function lots(book, { open } = {}) {
  const s = getSettings();
  const rows = db.prepare(`
    SELECT o.*, COALESCE(o.filled_amount, o.amount) AS cost,
           sl.id AS sell_id, sl.status AS sell_status
    FROM orders o
    LEFT JOIN sells sl ON sl.lot_id = o.id AND sl.status IN ('placed', 'filled', 'dry_run')
    WHERE o.status = ?
    ORDER BY o.id
  `).all(LOT_STATUS[book]);
  return rows
    .filter((r) => !open || !r.sell_id || r.sell_status === 'placed')
    .map((r) => ({
      ...r,
      paper: book === 'paper',
      stop_price: r.high_water ? round2(r.high_water * (1 - s.stop_loss_pct / 100)) : null,
      target_price: r.avg_price ? round2(r.avg_price * (1 + s.take_profit_pct / 100)) : null,
    }));
}

// The pot starts at budget_total and grows or shrinks with realized
// profit/loss. Remaining = pot - money in open lots - money in pending buys.
function bookState(book) {
  const s = getSettings();
  const realized = db.prepare(`
    SELECT COALESCE(SUM(sl.proceeds - COALESCE(o.filled_amount, o.amount)), 0) AS pnl
    FROM sells sl JOIN orders o ON o.id = sl.lot_id
    WHERE sl.status IN ${SELL_DONE[book]} AND o.status = ?
  `).get(LOT_STATUS[book]).pnl;
  const deployed = db.prepare(`
    SELECT COALESCE(SUM(COALESCE(o.filled_amount, o.amount)), 0) AS total
    FROM orders o
    WHERE o.status = ? AND NOT EXISTS (
      SELECT 1 FROM sells sl WHERE sl.lot_id = o.id AND sl.status IN ${SELL_DONE[book]})
  `).get(LOT_STATUS[book]).total;
  const pending = book === 'live'
    ? db.prepare("SELECT COALESCE(SUM(amount), 0) AS total FROM orders WHERE status IN ('reserved', 'placed')").get().total
    : 0;
  const pot = s.budget_total + realized;
  return {
    pot: round2(pot),
    realized_pnl: round2(realized),
    deployed: round2(deployed + pending),
    remaining: Math.max(0, round2(pot - deployed - pending)),
  };
}

function budgetState() {
  const s = getSettings();
  const live = bookState('live');
  const paper = bookState('paper');
  const active = s.mode === 'dry_run' ? paper : live;
  return { ...s, ...active, book: s.mode === 'dry_run' ? 'paper' : 'live', live, paper };
}

// Checked and recorded in one transaction so two reservations can't both
// squeeze under the cap. Paper buys fill instantly at the quoted price.
const reserve = db.transaction(({ pick_id, symbol, asset_type, amount, price }) => {
  const s = budgetState();
  if (s.mode === 'paused') return { ok: false, error: 'Buying is paused' };
  if (asset_type === 'crypto' && !s.crypto_enabled) return { ok: false, error: 'Crypto buying is turned off' };
  if (!(amount > 0)) return { ok: false, error: 'Amount must be greater than 0' };
  if (!(price > 0)) return { ok: false, error: 'Current price is required' };
  if (amount > s.max_order) return { ok: false, error: `Amount exceeds the $${s.max_order} per-order cap` };
  if (amount > s.remaining) return { ok: false, error: `Amount exceeds the $${s.remaining} remaining budget` };

  const live = s.mode === 'live';
  const info = live
    ? db.prepare(`INSERT INTO orders (pick_id, symbol, asset_type, amount, status) VALUES (?, ?, ?, ?, 'reserved')`)
      .run(pick_id || null, symbol, asset_type, amount)
    : db.prepare(`
        INSERT INTO orders (pick_id, symbol, asset_type, amount, status, filled_amount, filled_qty, avg_price, high_water, protection)
        VALUES (?, ?, ?, ?, 'dry_run', ?, ?, ?, ?, 'hourly_check')
      `).run(pick_id || null, symbol, asset_type, amount, amount, amount / price, price, price);

  return {
    ok: true,
    order_id: info.lastInsertRowid,
    mode: s.mode,
    place_order: live,
    remaining_after: round2(s.remaining - amount),
  };
});

module.exports = { MODES, NUMERIC, FLAGS, getSettings, setSetting, budgetState, lots, reserve };
