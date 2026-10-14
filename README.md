# TD SYNNEX stock proxy

A small Node server that holds your TD SYNNEX XML credentials and answers stock lookups from the SRX Firewall Selector.

## Setup
1. Install Node 18 or newer.
2. `npm install`
3. `cp .env.example .env`, then fill in the customer number, user name and password from your TD SYNNEX XML onboarding.
4. `npm start`
5. Test it: `curl "http://localhost:8787/pna?parts=SRX345-SYS-JB,SRX1600-AC"`
6. Put it behind HTTPS (nginx, IIS, or Azure / AWS app hosting). An https page can't call an http URL.
7. In the selector's Tweaks panel, set **TD SYNNEX proxy URL** to the server's base URL, e.g. `https://stock.visionnet.com`.

## Notes
- TD SYNNEX may only accept calls from IP addresses on its allowlist. Give your rep the server's public IP.
- Point `SYNNEX_URL` at the test endpoint until results look right.
- Confirm the response element names (`mfgPN`, `totalQuantity`, `price`, `eta`) against the current TD SYNNEX "XML Real Time Price & Availability" spec, and adjust the `tag(...)` names in `index.js` if they differ.
- If the page is hosted on a known domain, set `ALLOW_ORIGIN` to that domain instead of `*`.
