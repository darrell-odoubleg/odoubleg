const REFRESH_MS = 30 * 1000;

const el = {
  onlineCount: document.getElementById('online-count'),
  offlineCount: document.getElementById('offline-count'),
  onlineCard: document.getElementById('online-card'),
  offlineCard: document.getElementById('offline-card'),
  onlinePanel: document.getElementById('online-panel'),
  offlinePanel: document.getElementById('offline-panel'),
  onlineList: document.getElementById('online-list'),
  offlineList: document.getElementById('offline-list'),
  closedCount: document.getElementById('closed-count'),
  closedCard: document.getElementById('closed-card'),
  closedPanel: document.getElementById('closed-panel'),
  closedList: document.getElementById('closed-list'),
  closedSites: document.getElementById('closed-sites'),
  updatedAt: document.getElementById('updated-at'),
  errorBanner: document.getElementById('error-banner'),
  logoutBtn: document.getElementById('logout-btn'),
};

function fmtLastSeen(iso) {
  if (!iso) return 'unknown';
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return new Date(iso).toLocaleString();
}

const TYPE_LABELS = { ap: 'AP', switch: 'Switch', gateway: 'Gateway' };
function typeLabel(type) {
  return TYPE_LABELS[type] || type || 'Device';
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str == null ? '' : String(str);
  return div.innerHTML;
}

function renderList(listEl, aps, opts = {}) {
  listEl.innerHTML = '';
  for (const ap of aps) {
    const li = document.createElement('li');
    li.className = 'ap-row';
    if (opts.offline && !ap.acknowledged) li.classList.add('flash');

    const row = document.createElement('div');
    row.className = 'ap-row-main';

    if (opts.offline) {
      const ackWrap = document.createElement('div');
      ackWrap.className = 'ack-wrap';

      const ticketInput = document.createElement('input');
      ticketInput.type = 'text';
      ticketInput.className = 'ack-ticket';
      ticketInput.placeholder = 'SNOW ticket #';
      ticketInput.value = ap.ticket || '';
      ticketInput.disabled = !!ap.acknowledged;
      ticketInput.title = 'ServiceNow ticket number';

      const ackBtn = document.createElement('button');
      ackBtn.type = 'button';
      ackBtn.className = 'ack-btn';
      ackBtn.textContent = ap.acknowledged ? 'Acked' : 'Ack';
      ackBtn.disabled = !!ap.acknowledged;

      const submitAck = async () => {
        const ticket = ticketInput.value.trim();
        if (!ticket) { ticketInput.focus(); return; }
        ackBtn.disabled = true;
        ticketInput.disabled = true;
        try {
          const res = await fetch(`/api/aps/${encodeURIComponent(ap.id)}/ack`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ ticket }),
          });
          if (!res.ok) throw new Error(`Server returned ${res.status}`);
          li.classList.remove('flash');
          ackBtn.textContent = 'Acked';
        } catch (err) {
          ackBtn.disabled = false;
          ticketInput.disabled = false;
        }
      };

      ackBtn.addEventListener('click', submitAck);
      ticketInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); submitAck(); }
      });

      ackWrap.appendChild(ticketInput);
      ackWrap.appendChild(ackBtn);
      row.appendChild(ackWrap);
    }

    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'ap-toggle';
    toggle.innerHTML = `<span class="ap-name"><span class="type-badge type-${escapeHtml(ap.type || 'other')}">${escapeHtml(typeLabel(ap.type))}</span>${escapeHtml(ap.name)}</span><span class="ap-site">${escapeHtml(ap.orgName)} — ${escapeHtml(ap.siteName)}</span>`;

    const details = document.createElement('div');
    details.className = 'ap-details';
    details.hidden = true;
    details.innerHTML = `
      <dl>
        <dt>Type</dt><dd>${escapeHtml(typeLabel(ap.type))}</dd>
        <dt>Status</dt><dd>${escapeHtml(ap.status || 'unknown')}</dd>
        <dt>Org</dt><dd>${escapeHtml(ap.orgName)}</dd>
        <dt>Site</dt><dd>${escapeHtml(ap.siteName)}</dd>
        <dt>Model</dt><dd>${escapeHtml(ap.model || '—')}</dd>
        <dt>MAC</dt><dd>${escapeHtml(ap.mac || '—')}</dd>
        <dt>Serial</dt><dd>${escapeHtml(ap.serial || '—')}</dd>
        <dt>IP</dt><dd>${escapeHtml(ap.ip || '—')}</dd>
        <dt>Last seen</dt><dd>${escapeHtml(fmtLastSeen(ap.lastSeen))}</dd>
      </dl>
    `;
    details.appendChild(seasonButton({ id: ap.siteId, name: ap.siteName, orgName: ap.orgName }, !!opts.closed));

    toggle.addEventListener('click', () => {
      details.hidden = !details.hidden;
      toggle.classList.toggle('expanded', !details.hidden);
    });

    row.appendChild(toggle);
    li.appendChild(row);
    li.appendChild(details);
    listEl.appendChild(li);
  }
}

// Closing a site moves all of its devices to the "Closed for season" list
// (server-side, so it applies for every viewer).
async function setSeason(site, closed) {
  if (closed && !confirm(`Mark ${site.name} closed for the season?\n\nIts devices will stop counting as offline or raising alerts until it's reopened.`)) {
    return;
  }
  try {
    const res = await fetch(`/api/sites/${encodeURIComponent(site.id)}/season`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ closed, siteName: site.name, orgName: site.orgName }),
    });
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    map.closePopup();
    await refresh();
  } catch (err) {
    el.errorBanner.textContent = `Couldn't update site: ${err.message}`;
    el.errorBanner.hidden = false;
  }
}

function seasonButton(site, isClosed) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = isClosed ? 'season-btn reopen' : 'season-btn';
  btn.textContent = isClosed ? `Reopen ${site.name}` : `Close ${site.name} for season`;
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    setSeason(site, !isClosed);
  });
  return btn;
}

function renderClosedSites(sites, devices) {
  el.closedSites.innerHTML = '';
  for (const site of sites) {
    const count = devices.filter((d) => d.siteId === site.id).length;
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.innerHTML = `<strong>${escapeHtml(site.siteName || 'Unknown site')}</strong>` +
      `<span class="muted"> ${escapeHtml(site.orgName || '')} · ${count} device${count === 1 ? '' : 's'}</span>`;
    li.appendChild(label);
    li.appendChild(seasonButton({ id: site.id, name: site.siteName || 'site', orgName: site.orgName }, true));
    el.closedSites.appendChild(li);
  }
}

const map = L.map('site-map', { scrollWheelZoom: false }).setView([39.8, -98.6], 4);
// CARTO started watermarking keyless tiles ("API KEY REQUIRED") in Oct 2026;
// Esri's World Street Map is still served without a key.
L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
  attribution: 'Tiles &copy; Esri &mdash; Sources: Esri, HERE, Garmin, USGS, Intermap, INCREMENT P, NRCan, Esri Japan, METI, Esri China (Hong Kong), Esri Korea, Esri (Thailand), NGCC, &copy; OpenStreetMap contributors, and the GIS User Community',
  maxZoom: 19,
}).addTo(map);
const siteMarkers = L.layerGroup().addTo(map);
let mapFitted = false;

function renderSites(sites) {
  siteMarkers.clearLayers();
  if (!sites.length) return;

  const bounds = [];
  for (const site of sites) {
    const color = site.closed ? '#facc15' : site.offline > 0 ? '#dc2626' : '#16a34a';
    const marker = L.circleMarker([site.lat, site.lng], {
      radius: 7,
      weight: 2,
      // yellow needs a dark ring to stand out on the beige basemap
      color: site.closed ? '#854d0e' : '#ffffff',
      fillColor: color,
      fillOpacity: 0.9,
    });
    const popup = document.createElement('div');
    popup.className = 'site-popup';
    popup.innerHTML =
      `<strong>${escapeHtml(site.name)}</strong><br>` +
      `${escapeHtml(site.orgName)}<br>` +
      (site.closed ? '<span class="closed-tag">Closed for season</span>' : `${site.online} online / ${site.offline} offline`);
    popup.appendChild(seasonButton(site, site.closed));
    marker.bindPopup(popup);
    marker.addTo(siteMarkers);
    bounds.push([site.lat, site.lng]);
  }

  if (!mapFitted) {
    map.fitBounds(bounds, { padding: [30, 30], maxZoom: 6 });
    mapFitted = true;
  }
}

async function refresh() {
  try {
    const res = await fetch('/api/aps');
    if (res.status === 401) {
      window.location.href = '/login.html';
      return;
    }
    if (!res.ok) throw new Error(`Server returned ${res.status}`);
    const data = await res.json();

    el.onlineCount.textContent = data.counts.online;
    el.offlineCount.textContent = data.counts.offline;
    el.updatedAt.textContent = `Updated ${new Date(data.fetchedAt).toLocaleTimeString()}`;
    renderList(el.onlineList, data.online);
    renderList(el.offlineList, data.offline, { offline: true });
    el.closedCount.textContent = data.counts.closed || 0;
    renderClosedSites(data.closedSites || [], data.closed || []);
    renderList(el.closedList, data.closed || [], { closed: true });
    renderSites(data.sites || []);
    if (data.warnings && data.warnings.length) {
      el.errorBanner.textContent = `Partial data — ${data.warnings.join('; ')}`;
      el.errorBanner.hidden = false;
    } else {
      el.errorBanner.hidden = true;
    }

    // Keep the panel open as long as anything offline hasn't been
    // acknowledged yet — including if the user closes it and a new
    // unacknowledged AP shows up on a later poll.
    const hasUnacknowledged = data.offline.some((ap) => !ap.acknowledged);
    if (hasUnacknowledged && el.offlinePanel.hidden) {
      el.offlinePanel.hidden = false;
      el.offlinePanel.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  } catch (err) {
    el.errorBanner.textContent = `Couldn't load AP status: ${err.message}`;
    el.errorBanner.hidden = false;
  }
}

el.offlineCard.addEventListener('click', () => {
  el.offlinePanel.hidden = !el.offlinePanel.hidden;
});

el.closedCard.addEventListener('click', () => {
  el.closedPanel.hidden = !el.closedPanel.hidden;
});

el.onlineCard.addEventListener('click', () => {
  el.onlinePanel.hidden = !el.onlinePanel.hidden;
});

el.logoutBtn.addEventListener('click', async () => {
  await fetch('/logout', { method: 'POST' });
  window.location.href = '/login.html';
});

refresh();
setInterval(refresh, REFRESH_MS);
