const fetch = require('node-fetch');
const { annotateOffline } = require('./apState');
const { isClosed, listClosed } = require('./seasonState');

// Juniper Mist runs several regional cloud shards; a token only lives on one
// of them and there's no lookup-by-token endpoint, so each account probes
// /self on each candidate until one accepts its token, then caches it.
const CANDIDATE_HOSTS = [
  'api.mist.com',
  'api.gc2.mist.com',
  'api.gc3.mist.com',
  'api.gc4.mist.com',
  'api.eu.mist.com',
  'api.ac2.mist.com',
];

// Supports one or more MSP accounts, each with its own token (and possibly
// its own cloud shard). MIST_API_TOKEN/MIST_MSP_ID is account 1 for
// backward compatibility; additional accounts are MIST_API_TOKEN_2/
// MIST_MSP_ID_2, _3, etc.
function loadAccounts() {
  const accounts = [];
  if (process.env.MIST_API_TOKEN && process.env.MIST_MSP_ID) {
    accounts.push({ token: process.env.MIST_API_TOKEN, mspId: process.env.MIST_MSP_ID });
  }
  let i = 2;
  while (process.env[`MIST_API_TOKEN_${i}`] && process.env[`MIST_MSP_ID_${i}`]) {
    accounts.push({ token: process.env[`MIST_API_TOKEN_${i}`], mspId: process.env[`MIST_MSP_ID_${i}`] });
    i++;
  }
  return accounts;
}

const ACCOUNTS = loadAccounts();
const hostByToken = new Map();

async function resolveHost(token) {
  if (hostByToken.has(token)) return hostByToken.get(token);

  for (const host of CANDIDATE_HOSTS) {
    try {
      const res = await fetch(`https://${host}/api/v1/self`, { headers: { Authorization: `Token ${token}` } });
      if (res.ok) {
        hostByToken.set(token, host);
        return host;
      }
    } catch (err) {
      // network error on this shard, try the next
    }
  }

  throw new Error(
    'Could not find a Mist API region that accepts one of the configured tokens. ' +
    'Check the URL in the Mist dashboard (e.g. manage.<region>.mist.com) and add it to CANDIDATE_HOSTS.'
  );
}

async function mistGet(token, path) {
  const host = await resolveHost(token);
  const res = await fetch(`https://${host}${path}`, { headers: { Authorization: `Token ${token}` } });
  if (!res.ok) {
    throw new Error(`Mist API ${path} failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

// Mist has no MSP-wide device-status endpoint, so the org list and each
// org's sites are cached longer (they rarely change) to keep the per-refresh
// API call count down — only device stats are fetched fresh every time.
const ORG_CACHE_MS = 10 * 60 * 1000;
const orgsCacheByMsp = new Map();

async function getOrgsForAccount(account) {
  const cached = orgsCacheByMsp.get(account.mspId);
  if (cached && Date.now() < cached.expiresAt) return cached.data;

  const orgs = await mistGet(account.token, `/api/v1/msps/${account.mspId}/orgs`);
  // tag each org with the token that can read it, since accounts may live on different shards
  const tagged = orgs.map((o) => ({ id: o.id, name: o.name, token: account.token }));
  orgsCacheByMsp.set(account.mspId, { data: tagged, expiresAt: Date.now() + ORG_CACHE_MS });
  return tagged;
}

const sitesCacheByOrg = new Map();

async function getSitesForOrg(org) {
  const cached = sitesCacheByOrg.get(org.id);
  if (cached && Date.now() < cached.expiresAt) return cached.data;

  const sites = await mistGet(org.token, `/api/v1/orgs/${org.id}/sites`);
  const byId = new Map();
  for (const site of sites) {
    byId.set(site.id, {
      name: site.name,
      lat: site.latlng ? site.latlng.lat : null,
      lng: site.latlng ? site.latlng.lng : null,
    });
  }
  sitesCacheByOrg.set(org.id, { data: byId, expiresAt: Date.now() + ORG_CACHE_MS });
  return byId;
}

// type=all covers APs, switches and gateways; Mist's default page size is
// 100, so ask for more than any single org has.
async function fetchDeviceStatsForOrg(org) {
  return mistGet(org.token, `/api/v1/orgs/${org.id}/stats/devices?type=all&limit=1000`);
}

async function getApsForOrg(org) {
  try {
    const [devices, sites] = await Promise.all([
      fetchDeviceStatsForOrg(org),
      getSitesForOrg(org),
    ]);
    return devices.map((d) => ({
      id: d.id,
      name: d.name || d.hostname || d.mac,
      type: d.type,
      mac: d.mac,
      model: d.model,
      serial: d.serial,
      ip: d.ip,
      orgId: org.id,
      orgName: org.name,
      siteId: d.site_id,
      siteName: (sites.get(d.site_id) || {}).name || 'Unknown site',
      status: d.status,
      lastSeen: d.last_seen ? new Date(d.last_seen * 1000).toISOString() : null,
    }));
  } catch (err) {
    console.error(`Failed to fetch devices for org ${org.name} (${org.id}):`, err.message);
    return [];
  }
}

// One row per site (with known coordinates), carrying AP counts so map
// markers can be colored without the client re-deriving it from the AP list.
async function getSiteSummaries(orgs) {
  const perOrgSites = await Promise.all(orgs.map(getSitesForOrg));
  const byId = new Map();
  orgs.forEach((org, i) => {
    for (const [siteId, site] of perOrgSites[i]) {
      if (site.lat == null || site.lng == null) continue;
      byId.set(siteId, {
        id: siteId,
        name: site.name,
        orgName: org.name,
        lat: site.lat,
        lng: site.lng,
        online: 0,
        offline: 0,
        closed: isClosed(siteId),
      });
    }
  });
  return byId;
}

async function getApStatus() {
  // One account losing access (revoked token, removed privileges) shouldn't
  // blank the dashboard for every other MSP, so failures become warnings.
  const warnings = [];
  const orgsByAccount = await Promise.all(
    ACCOUNTS.map((account, i) =>
      getOrgsForAccount(account).catch((err) => {
        console.error(`Failed to load orgs for MIST account ${i + 1} (MSP ${account.mspId}):`, err.message);
        warnings.push(`Mist account ${i + 1} (MSP ${account.mspId}) unavailable: ${err.message}`);
        return [];
      })
    )
  );
  if (ACCOUNTS.length && warnings.length === ACCOUNTS.length) {
    throw new Error(warnings.join('; '));
  }
  const orgs = orgsByAccount.flat();
  const [perOrg, siteSummaries] = await Promise.all([
    Promise.all(orgs.map(getApsForOrg)),
    getSiteSummaries(orgs),
  ]);
  const all = perOrg.flat();

  const online = [];
  const offline = [];
  const closed = [];
  for (const ap of all) {
    if (isClosed(ap.siteId)) closed.push(ap);
    else if (ap.status === 'connected') online.push(ap);
    else offline.push(ap);
    const site = siteSummaries.get(ap.siteId);
    if (site) {
      if (ap.status === 'connected') site.online++;
      else site.offline++;
    }
  }

  const byOrgSite = (a, b) =>
    a.orgName.localeCompare(b.orgName) || a.siteName.localeCompare(b.siteName) || a.name.localeCompare(b.name);
  online.sort(byOrgSite);
  offline.sort(byOrgSite);
  closed.sort(byOrgSite);
  annotateOffline(offline);

  return {
    counts: { online: online.length, offline: offline.length, closed: closed.length, total: all.length },
    online,
    offline,
    closed,
    closedSites: listClosed(),
    sites: Array.from(siteSummaries.values()),
    warnings,
    fetchedAt: new Date().toISOString(),
  };
}

module.exports = { getApStatus, acknowledge: require('./apState').acknowledge };
