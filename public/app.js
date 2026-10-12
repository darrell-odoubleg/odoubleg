const $ = (id) => document.getElementById(id);

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const money = (n) => (n == null ? '—' : '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const qty = (n) => (n == null ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 8 }));

const BANNERS = {
  live: 'LIVE — the routine is placing real orders with real money.',
  dry_run: 'Dry run — the routine researches and trades paper money only. Real positions it already bought are still protected.',
  paused: 'Paused — no new buys. The routine still watches and sells open positions.',
};

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (res.status === 401) { location.href = '/login.html'; throw new Error('signed out'); }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

const PROTECTION = { broker_trailing: 'Robinhood trailing stop', broker_stop: 'Robinhood stop', hourly_check: 'Hourly check' };
const REASONS = { stop_loss: 'Stop loss', take_profit: 'Take profit', signal: 'Signal' };
const pnlCell = (n) => (n == null ? '—' : `<span class="${n >= 0 ? 'gain' : 'loss'}">${n >= 0 ? '+' : '−'}${money(Math.abs(n))}</span>`);

function renderState({ budget, positions, sells, orders }) {
  $('mode-banner').className = 'banner ' + budget.mode;
  $('mode-banner').textContent = BANNERS[budget.mode];
  document.querySelectorAll('.modes button').forEach((b) => b.classList.toggle('active', b.dataset.mode === budget.mode));

  $('s-pot-label').textContent = budget.book === 'paper' ? 'Pot (paper)' : 'Pot';
  $('s-pot').textContent = money(budget.pot);
  $('s-used').textContent = money(budget.deployed);
  $('s-left').textContent = money(budget.remaining);
  $('s-pnl').innerHTML = pnlCell(budget.realized_pnl);
  $('meter').style.width = Math.min(100, (budget.deployed / (budget.pot || 1)) * 100) + '%';
  $('s-note').textContent = `Sells put money back in the pot. Max ${money(budget.max_order)} per buy; trailing stop ${budget.stop_loss_pct}%, take profit +${budget.take_profit_pct}%.`
    + (budget.book === 'paper' && budget.live.deployed ? ` Real money invested: ${money(budget.live.deployed)}.` : '');

  const form = $('settings');
  if (document.activeElement.form !== form) {
    form.budget_total.value = budget.budget_total;
    form.max_order.value = budget.max_order;
    form.stop_loss_pct.value = budget.stop_loss_pct;
    form.take_profit_pct.value = budget.take_profit_pct;
  }

  $('positions').innerHTML = positions.length ? positions.map((p) => `
    <tr><td><strong>${escapeHtml(p.symbol)}</strong>${p.paper ? ' <span class="tag dry_run">paper</span>' : ''}${p.sell_status === 'placed' ? ' <span class="tag placed">selling</span>' : ''}</td>
    <td>${escapeHtml(p.asset_type)}</td><td class="num">${money(p.cost)}</td><td class="num">${qty(p.filled_qty)}</td>
    <td class="num">${money(p.avg_price)}</td><td class="num">${money(p.high_water)}</td>
    <td class="num">${money(p.stop_price)}</td><td class="num">${money(p.target_price)}</td>
    <td>${escapeHtml(PROTECTION[p.protection] || 'Not set yet')}</td><td>${escapeHtml(p.created_at)}</td></tr>`).join('')
    : '<tr><td colspan="10" class="empty">No open positions.</td></tr>';

  $('sells').innerHTML = sells.length ? sells.map((x) => `
    <tr><td>${escapeHtml(x.created_at)}</td><td><strong>${escapeHtml(x.symbol)}</strong>${x.paper ? ' <span class="tag dry_run">paper</span>' : ''}</td>
    <td>${escapeHtml(REASONS[x.reason] || x.reason)}</td>
    <td><span class="tag ${escapeHtml(x.status)}">${escapeHtml(x.status.replace('_', ' '))}</span></td>
    <td class="num">${money(x.cost)}</td><td class="num">${money(x.proceeds)}</td><td class="num">${pnlCell(x.pnl)}</td>
    <td class="why-cell">${escapeHtml(x.reasoning || x.error || '')}</td></tr>`).join('')
    : '<tr><td colspan="8" class="empty">Nothing sold yet.</td></tr>';

  $('orders').innerHTML = orders.length ? orders.map((o) => `
    <tr><td class="num">${o.id}</td><td>${escapeHtml(o.created_at)}</td><td><strong>${escapeHtml(o.symbol)}</strong></td>
    <td>${escapeHtml(o.asset_type)}</td><td class="num">${money(o.amount)}</td>
    <td><span class="tag ${escapeHtml(o.status)}">${escapeHtml(o.status.replace('_', ' '))}</span></td>
    <td class="num">${money(o.filled_amount)}</td><td class="num">${money(o.avg_price)}</td>
    <td>${escapeHtml(o.error || '')}</td></tr>`).join('')
    : '<tr><td colspan="9" class="empty">No orders yet.</td></tr>';
}

function renderRuns(runs) {
  $('runs').innerHTML = runs.length ? runs.map((r) => `
    <div class="run">
      <div class="run-head"><strong>${escapeHtml(r.created_at)} UTC</strong>
        <span class="tag ${r.mode === 'live' ? 'failed' : 'dry_run'}">${escapeHtml(r.mode.replace('_', ' '))}</span></div>
      <p class="run-summary">${escapeHtml(r.summary)}</p>
      ${r.picks.map((p) => `
        <div class="pick">
          <div><div class="sym">${escapeHtml(p.symbol)}</div><span class="tag ${escapeHtml(p.action)}">${escapeHtml(p.action)}</span></div>
          <div>
            <div class="muted">${escapeHtml(p.asset_type)}${p.conviction != null ? ` · conviction ${p.conviction}/10` : ''}${p.price != null ? ` · ${money(p.price)}` : ''}${p.order_amount != null ? ` · ${money(p.order_amount)} ${escapeHtml((p.order_status || '').replace('_', ' '))}` : ''}</div>
            <div class="why">${escapeHtml(p.reasoning)}</div>
          </div>
        </div>`).join('')}
    </div>`).join('')
    : '<p class="empty">The routine hasn\'t run yet.</p>';
}

async function refresh() {
  const [state, runs] = await Promise.all([api('/api/state'), api('/api/runs')]);
  renderState(state);
  renderRuns(runs);
}

function saveSettings(body) {
  return api('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
}

document.querySelectorAll('.modes button').forEach((b) => b.addEventListener('click', async () => {
  const mode = b.dataset.mode;
  if (mode === 'live' && !confirm('Switch to LIVE? The routine will buy and sell stocks and crypto with real money, without asking you, within your pot.')) return;
  try { await saveSettings({ mode }); await refresh(); } catch (e) { alert(e.message); }
}));

$('settings').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await saveSettings({
      budget_total: f.budget_total.value, max_order: f.max_order.value,
      stop_loss_pct: f.stop_loss_pct.value, take_profit_pct: f.take_profit_pct.value,
    });
    document.activeElement.blur();
    await refresh();
  } catch (err) { alert(err.message); }
});

$('logout').addEventListener('click', async () => {
  await fetch('/logout', { method: 'POST' });
  location.href = '/login.html';
});

refresh();
setInterval(refresh, 60000);
