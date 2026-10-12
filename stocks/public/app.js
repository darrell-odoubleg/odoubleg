const $ = (id) => document.getElementById(id);

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
const money = (n) => (n == null ? '—' : '$' + Number(n).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const qty = (n) => (n == null ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 8 }));

const BANNERS = {
  live: 'LIVE — the routine is placing real orders with real money.',
  dry_run: 'Dry run — the routine researches and logs picks but places no orders. Budget below is paper money.',
  paused: 'Paused — the routine still researches, but every purchase is refused.',
};

async function api(path, opts) {
  const res = await fetch(path, opts);
  if (res.status === 401) { location.href = '/login.html'; throw new Error('signed out'); }
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || 'Request failed');
  return data;
}

function renderState({ budget, holdings, orders }) {
  $('mode-banner').className = 'banner ' + budget.mode;
  $('mode-banner').textContent = BANNERS[budget.mode];
  document.querySelectorAll('.modes button').forEach((b) => b.classList.toggle('active', b.dataset.mode === budget.mode));

  $('s-total').textContent = money(budget.budget_total);
  $('s-used-label').textContent = budget.mode === 'dry_run' ? 'Committed (paper)' : 'Committed';
  $('s-used').textContent = money(budget.committed);
  $('s-left').textContent = money(budget.remaining);
  $('s-max').textContent = money(budget.max_order);
  $('meter').style.width = Math.min(100, (budget.committed / (budget.budget_total || 1)) * 100) + '%';

  const form = $('settings');
  if (document.activeElement.form !== form) {
    form.budget_total.value = budget.budget_total;
    form.max_order.value = budget.max_order;
  }

  $('holdings').innerHTML = holdings.length ? holdings.map((h) => `
    <tr><td><strong>${escapeHtml(h.symbol)}</strong></td><td>${escapeHtml(h.asset_type)}</td>
    <td class="num">${money(h.invested)}</td><td class="num">${qty(h.qty)}</td>
    <td class="num">${h.orders}</td><td>${escapeHtml(h.last_buy)}</td></tr>`).join('')
    : '<tr><td colspan="6" class="empty">Nothing bought yet.</td></tr>';

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
  if (mode === 'live' && !confirm('Switch to LIVE? The routine will buy stocks and crypto with real money, without asking you, up to your spending cap.')) return;
  try { await saveSettings({ mode }); await refresh(); } catch (e) { alert(e.message); }
}));

$('settings').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = e.target;
  try {
    await saveSettings({ budget_total: f.budget_total.value, max_order: f.max_order.value });
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
