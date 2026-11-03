// sftp.js: sends export files to Equifax's managed file transfer (files.com
// behind transfer[.uat].us.equifax.com) over SFTP with password login.
// Settings live in .env (EQUIFAX_SFTP_*). Equifax's server key is pinned by
// SHA256 fingerprint (EQUIFAX_SFTP_HOSTKEY) so the file can't be handed to an
// impostor. Files go up unencrypted: Equifax agreed O Double G won't PGP them.

const crypto = require('crypto');
const path = require('path').posix;
const Client = require('ssh2-sftp-client');

function cfg() {
  const e = process.env;
  return {
    host: e.EQUIFAX_SFTP_HOST || '',
    port: Number(e.EQUIFAX_SFTP_PORT || 22),
    username: e.EQUIFAX_SFTP_USER || '',
    password: e.EQUIFAX_SFTP_PASSWORD || '',
    dir: e.EQUIFAX_SFTP_DIR || '/',
    hostkey: e.EQUIFAX_SFTP_HOSTKEY || '',
  };
}

function info() {
  const c = cfg();
  return {
    configured: !!(c.host && c.username && c.password),
    host: c.host, port: c.port, username: c.username, dir: c.dir,
    environment: /\buat\b|\.uat\./i.test(c.host) ? 'UAT (test)' : 'Production',
    hostkey_pinned: !!c.hostkey,
  };
}

const fingerprint = key => 'SHA256:' + crypto.createHash('sha256').update(key).digest('base64').replace(/=+$/, '');

async function withClient(fn) {
  const c = cfg();
  if (!c.host || !c.username || !c.password) throw Object.assign(new Error('sftp not configured'), { userMessage: 'Equifax SFTP is not set up on the server.' });
  const client = new Client();
  let badKey = null;
  try {
    await client.connect({
      host: c.host, port: c.port, username: c.username, password: c.password,
      readyTimeout: 20000,
      hostVerifier: key => { const fp = fingerprint(key); if (c.hostkey && fp !== c.hostkey) { badKey = fp; return false; } return true; },
    });
  } catch (e) {
    if (badKey) throw Object.assign(new Error(`host key ${badKey}`), { userMessage: `Equifax's server identified itself with a different key than before (${badKey}). Nothing was sent. If Equifax changed servers, update EQUIFAX_SFTP_HOSTKEY.` });
    const m = String(e.message || '');
    if (/authentication/i.test(m)) throw Object.assign(e, { userMessage: 'Equifax rejected the SFTP username or password.' });
    if (/timed out|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EHOSTUNREACH/i.test(m)) throw Object.assign(e, { userMessage: `Could not reach ${c.host}. Equifax may need this server's IP address whitelisted.` });
    throw Object.assign(e, { userMessage: `SFTP connection failed: ${m}` });
  }
  try { return await fn(client, c); } finally { client.end().catch(() => {}); }
}

// Logs in and lists the target folder. Sends nothing.
function test() {
  return withClient(async (client, c) => {
    if (!(await client.exists(c.dir))) throw Object.assign(new Error('no dir'), { userMessage: `Logged in, but the folder ${c.dir} does not exist on Equifax's server.` });
    const files = await client.list(c.dir);
    return { dir: c.dir, files: files.length };
  });
}

function send(filename, buffer, { overwrite = false } = {}) {
  return withClient(async (client, c) => {
    const remote = path.join(c.dir, filename);
    if (!overwrite && await client.exists(remote)) {
      throw Object.assign(new Error('exists'), { code: 'EXISTS', userMessage: `${filename} is already in the Equifax folder (sent earlier today).` });
    }
    try {
      await client.put(buffer, remote);
    } catch (e) {
      throw Object.assign(e, { userMessage: `Upload failed: ${e.message}` });
    }
    return { remote_path: remote };
  });
}

module.exports = { info, test, send };
