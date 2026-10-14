const el = {
  body: document.getElementById('sites-body'),
  empty: document.getElementById('sites-empty'),
  filter: document.getElementById('site-filter'),
  withContract: document.getElementById('with-contract'),
  todayLabel: document.getElementById('today-label'),
  errorBanner: document.getElementById('error-banner'),
  logoutBtn: document.getElementById('logout-btn'),
};

const STATUS_LABELS = { active: 'Active', upcoming: 'Upcoming', expired: 'Expired', none: 'No contract' };

let sites = [];

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

function showError(msg) {
  el.errorBanner.textContent = msg;
  el.errorBanner.hidden = !msg;
}

function statusBadge(site) {
  const closed = site.closed ? ` <span class="muted">· ${site.closed} in vacation</span>` : '';
  return `<span class="contract-status status-${site.status}">${STATUS_LABELS[site.status]}</span>${closed}`;
}

function render() {
  const q = el.filter.value.trim().toLowerCase();
  const rows = sites.filter((s) =>
    (!el.withContract.checked || s.contract) &&
    (!q || s.orgName.toLowerCase().includes(q) || s.name.toLowerCase().includes(q))
  );

  el.body.innerHTML = '';
  el.empty.hidden = rows.length > 0;

  for (const site of rows) {
    const c = site.contract || {};
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(site.orgName)}</td>
      <td>${escapeHtml(site.name)}</td>
      <td><input type="date" class="contract-input" data-field="start" value="${escapeHtml(c.start || '')}"></td>
      <td><input type="date" class="contract-input" data-field="end" value="${escapeHtml(c.end || '')}"></td>
      <td><input type="text" class="contract-input contract-notes" data-field="notes" maxlength="500" placeholder="Optional" value="${escapeHtml(c.notes || '')}"></td>
      <td class="status-cell">${statusBadge(site)}</td>
      <td class="contract-actions">
        <button type="button" class="ack-btn save-btn">Save</button>
        ${site.contract ? '<button type="button" class="link-btn clear-btn">Remove</button>' : ''}
      </td>
    `;

    const field = (name) => tr.querySelector(`[data-field="${name}"]`);
    const saveBtn = tr.querySelector('.save-btn');

    saveBtn.addEventListener('click', async () => {
      const start = field('start').value;
      const end = field('end').value;
      if (!start || !end) { showError('Enter both a start and end date.'); return; }
      saveBtn.disabled = true;
      try {
        const res = await fetch(`/api/admin/contracts/${encodeURIComponent(site.id)}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ start, end, notes: field('notes').value }),
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(data.error || `Server returned ${res.status}`);
        showError('');
        await load();
      } catch (err) {
        showError(`Couldn't save ${site.name}: ${err.message}`);
        saveBtn.disabled = false;
      }
    });

    const clearBtn = tr.querySelector('.clear-btn');
    if (clearBtn) {
      clearBtn.addEventListener('click', async () => {
        const warn = site.closed ? `\n\nIts ${site.closed} device(s) in vacation mode will be reopened.` : '';
        if (!confirm(`Remove the contract for ${site.name}?${warn}`)) return;
        clearBtn.disabled = true;
        try {
          const res = await fetch(`/api/admin/contracts/${encodeURIComponent(site.id)}`, { method: 'DELETE' });
          if (!res.ok) throw new Error(`Server returned ${res.status}`);
          showError('');
          await load();
        } catch (err) {
          showError(`Couldn't remove contract: ${err.message}`);
          clearBtn.disabled = false;
        }
      });
    }

    el.body.appendChild(tr);
  }
}

async function load() {
  try {
    const res = await fetch('/api/admin/sites');
    if (res.status === 401 || res.status === 403) {
      window.location.href = '/login.html?admin=1';
      return;
    }
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `Server returned ${res.status}`);
    sites = data.sites;
    el.todayLabel.textContent = ` (today is ${data.today})`;
    if (data.warnings && data.warnings.length) showError(`Partial data — ${data.warnings.join('; ')}`);
    render();
  } catch (err) {
    showError(`Couldn't load sites: ${err.message}`);
  }
}

el.filter.addEventListener('input', render);
el.withContract.addEventListener('change', render);
el.logoutBtn.addEventListener('click', async () => {
  await fetch('/logout', { method: 'POST' });
  window.location.href = '/login.html';
});

load();
