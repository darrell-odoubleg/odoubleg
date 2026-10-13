const fs = require('fs');
const path = require('path');

// Sites marked "closed for season" (e.g. campgrounds over winter). Their
// devices are pulled out of the online/offline lists so expected outages
// don't flash as alerts. Keyed by Mist site id.
const STATE_FILE = path.join(__dirname, '..', 'data', 'closed-sites.json');

function loadState() {
  try {
    return new Map(Object.entries(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))));
  } catch {
    return new Map();
  }
}

const closedSites = loadState();

function saveState() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(Object.fromEntries(closedSites)));
}

function isClosed(siteId) {
  return closedSites.has(siteId);
}

function listClosed() {
  return Array.from(closedSites, ([id, s]) => ({ id, ...s }));
}

function setClosed(siteId, closed, { siteName, orgName } = {}) {
  if (closed) {
    closedSites.set(siteId, {
      siteName: siteName || null,
      orgName: orgName || null,
      closedAt: new Date().toISOString(),
    });
  } else {
    closedSites.delete(siteId);
  }
  saveState();
}

module.exports = { isClosed, listClosed, setClosed };
