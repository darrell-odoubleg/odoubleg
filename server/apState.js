const fs = require('fs');
const path = require('path');

const STATE_FILE = path.join(__dirname, '..', 'data', 'ap-state.json');
const ALERT_WINDOW_MS = 24 * 60 * 60 * 1000;

function loadState() {
  try {
    return new Map(Object.entries(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))));
  } catch {
    return new Map();
  }
}

const state = loadState();

function saveState() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(Object.fromEntries(state)));
}

// Mutates each offline AP with `acknowledged` and `isNewEvent`, tracking
// per-device offline history so a flapping AP that was already offline
// within the last 24h doesn't re-trigger the alert.
function annotateOffline(offlineAps) {
  const now = Date.now();
  const offlineIds = new Set(offlineAps.map((ap) => ap.id));
  let dirty = false;

  for (const ap of offlineAps) {
    const prev = state.get(ap.id);
    const wasCurrentlyOffline = !!(prev && prev.offline);
    const recentlyOffline = !!(prev && now - prev.lastOfflineAt < ALERT_WINDOW_MS);
    const isNewEvent = !wasCurrentlyOffline && !recentlyOffline;

    const next = {
      offline: true,
      lastOfflineAt: now,
      acknowledged: isNewEvent ? false : !!(prev && prev.acknowledged),
      ticket: isNewEvent ? null : (prev && prev.ticket) || null,
    };
    state.set(ap.id, next);
    ap.isNewEvent = isNewEvent;
    ap.acknowledged = next.acknowledged;
    ap.ticket = next.ticket;
    if (isNewEvent) dirty = true;
  }

  // Devices that came back online keep their history (lastOfflineAt,
  // acknowledged) so the 24h window still applies if they drop again.
  for (const [id, s] of state) {
    if (s.offline && !offlineIds.has(id)) {
      state.set(id, { ...s, offline: false });
      dirty = true;
    }
  }

  if (dirty) saveState();
}

// Requires a ServiceNow ticket number — acknowledging without one is not
// allowed so there's always a paper trail for an outage that got dismissed.
function acknowledge(id, ticket) {
  const trimmed = (ticket || '').trim();
  if (!trimmed) return { ok: false, error: 'A ServiceNow ticket number is required to acknowledge.' };
  const prev = state.get(id);
  if (!prev) return { ok: false, error: 'Unknown AP id' };
  state.set(id, { ...prev, acknowledged: true, ticket: trimmed });
  saveState();
  return { ok: true, ticket: trimmed };
}

module.exports = { annotateOffline, acknowledge };
