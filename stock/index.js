// TD SYNNEX Price & Availability proxy for the SRX Firewall Selector.
// GET /k/<PROXY_KEY>/pna?parts=SKU1,SKU2  ->  { items: [{ sku, qty, eta, cost }] }
// The selector is a standalone HTML file opened from people's computers, so
// its origin is "null" and CORS can't restrict who calls this. Instead the
// secret key is part of the base URL pasted into the selector's Tweaks panel;
// rotate PROXY_KEY to cut off a leaked copy.
import 'dotenv/config';
import express from 'express';
import { timingSafeEqual } from 'crypto';

const {
  SYNNEX_URL = 'https://ec.synnex.com/SynnexXML/PriceAvailability',
  SYNNEX_CUST, SYNNEX_USER, SYNNEX_PASS,
  ALLOW_ORIGIN = '*', CACHE_MINUTES = '10', PORT = '8787', HOST = '127.0.0.1', PROXY_KEY
} = process.env;
if (!SYNNEX_CUST || !SYNNEX_USER || !SYNNEX_PASS) { console.error('Missing SYNNEX_CUST / SYNNEX_USER / SYNNEX_PASS in .env'); process.exit(1); }
if (!PROXY_KEY || PROXY_KEY.length < 16) { console.error('PROXY_KEY in .env must be at least 16 characters'); process.exit(1); }

const app = express(), cache = new Map(), TTL = +CACHE_MINUTES * 60e3;
const esc = s => String(s).replace(/[<>&'"]/g, c => `&#${c.charCodeAt(0)};`);
const tag = (x, t) => (x.match(new RegExp(`<${t}>([^<]*)</${t}>`, 'i')) || [])[1];

app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', ALLOW_ORIGIN);
  res.set('Access-Control-Allow-Headers', 'Accept');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.get('/health', (_, res) => res.json({ ok: true }));

const keyBuf = Buffer.from(PROXY_KEY);
const pna = express.Router();
// Wrong key looks the same as a missing route, so the URL can't be probed.
app.use('/k/:key', (req, res, next) => {
  const given = Buffer.from(req.params.key);
  if (given.length === keyBuf.length && timingSafeEqual(given, keyBuf)) return next();
  res.sendStatus(404);
}, pna);

pna.get('/pna', async (req, res) => {
  const parts = [...new Set(String(req.query.parts || '').split(',').map(s => s.trim()).filter(Boolean))].slice(0, 40);
  if (!parts.length) return res.status(400).json({ error: 'parts query param required' });
  const now = Date.now(), miss = parts.filter(p => !(cache.get(p.toUpperCase())?.t > now - TTL));
  try {
    if (miss.length) {
      // TD SYNNEX matches mfgPN case-sensitively and Juniper part numbers are uppercase.
      const body = `<?xml version="1.0" encoding="UTF-8"?><priceRequest><customerNo>${esc(SYNNEX_CUST)}</customerNo><userName>${esc(SYNNEX_USER)}</userName><password>${esc(SYNNEX_PASS)}</password>${miss.map((p, i) => `<skuList><mfgPN>${esc(p.toUpperCase())}</mfgPN><lineNumber>${i + 1}</lineNumber></skuList>`).join('')}</priceRequest>`;
      const r = await fetch(SYNNEX_URL, { method: 'POST', headers: { 'Content-Type': 'application/xml' }, body });
      const xml = await r.text();
      if (!r.ok) throw new Error(`TD SYNNEX HTTP ${r.status}`);
      // Bad credentials etc. come back as HTTP 200 with an <errorMessage>, not an empty list.
      const err = tag(xml, 'errorMessage');
      if (err) throw new Error(`TD SYNNEX ${err}: ${tag(xml, 'errorDetail') || ''}`.trim());
      for (const row of xml.split(/<PriceAvailabilityList>/i).slice(1)) {
        const sku = tag(row, 'mfgPN');
        if (!sku || /not ?found|discontinued/i.test(tag(row, 'status') || '')) continue;
        const etas = [...row.matchAll(/<eta[^>]*>([^<]+)<\/eta>/gi)].map(m => m[1].trim()).filter(Boolean).sort();
        const price = tag(row, 'price');
        cache.set(sku.toUpperCase(), { t: now, v: { sku, qty: parseInt(tag(row, 'totalQuantity'), 10) || 0, cost: price ? +price : null, eta: etas[0]?.slice(0, 10) || null } });
      }
      miss.forEach(p => { if (!cache.has(p.toUpperCase())) cache.set(p.toUpperCase(), { t: now, v: null }); });
    }
    res.json({ items: parts.map(p => { const v = cache.get(p.toUpperCase())?.v; return v && { ...v, sku: p }; }).filter(Boolean) });
  } catch (e) {
    console.error(e);
    res.status(502).json({ error: e.message });
  }
});

app.listen(+PORT, HOST, () => console.log(`SYNNEX proxy on ${HOST}:${PORT}`));
