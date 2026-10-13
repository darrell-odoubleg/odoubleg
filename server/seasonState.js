const fs = require('fs');
const path = require('path');

// Devices marked "closed for season" (e.g. a campground cabin AP that's
// powered off over winter). They're pulled out of the online/offline lists
// so expected outages don't flash as alerts. Keyed by Mist device id.
const STATE_FILE = path.join(__dirname, '..', 'data', 'closed-devices.json');

function loadState() {
  try {
    return new Map(Object.entries(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))));
  } catch {
    return new Map();
  }
}

const closedDevices = loadState();

function saveState() {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(Object.fromEntries(closedDevices)));
}

function isClosed(deviceId) {
  return closedDevices.has(deviceId);
}

function getClosed(deviceId) {
  return closedDevices.get(deviceId) || null;
}

function setClosed(deviceId, closed, { name, siteName, orgName } = {}) {
  if (closed) {
    closedDevices.set(deviceId, {
      name: name || null,
      siteName: siteName || null,
      orgName: orgName || null,
      closedAt: new Date().toISOString(),
    });
  } else {
    closedDevices.delete(deviceId);
  }
  saveState();
}

module.exports = { isClosed, getClosed, setClosed };
