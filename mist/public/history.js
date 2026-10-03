const el = {
  filter: document.getElementById('history-filter'),
  body: document.getElementById('history-body'),
  empty: document.getElementById('history-empty'),
  errorBanner: document.getElementById('error-banner'),
  logoutBtn: document.getElementById('logout-btn'),
};

let rows = [];

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

function fmtDateTime(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}

function render() {
  const q = el.filter.value.trim().toLowerCase();
  const filtered = q
    ? rows.filter((r) =>
        [r.ap_name, r.org_name, r.site_name, r.ticket].some((v) => (v || '').toLowerCase().includes(q))
      )
    : rows;

  el.body.innerHTML = filtered
    .map(
      (r) => `
        <tr>
          <td>${escapeHtml(fmtDateTime(r.acknowledged_at))}</td>
          <td>${escapeHtml(r.ap_name || '—')}</td>
          <td>${escapeHtml(r.org_name || '—')}</td>
          <td>${escapeHtml(r.site_name || '—')}</td>
          <td>${escapeHtml(r.ticket)}</td>
        </tr>
      `
    )
    .join('');

  el.empty.hidden = filtered.length > 0;
}

async function load() {
  try {
    const res = await fetch('/api/ack-history');
    if (res.status === 401) {
      window.location.href = '/login.html';
      return;
    }
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    const data = await res.json();
    rows = data.history || [];
    render();
    el.errorBanner.hidden = true;
  } catch (err) {
    el.errorBanner.textContent = `Couldn't load history: ${err.message}`;
    el.errorBanner.hidden = false;
  }
}

el.filter.addEventListener('input', render);

el.logoutBtn.addEventListener('click', async () => {
  await fetch('/logout', { method: 'POST' });
  window.location.href = '/login.html';
});

load();
