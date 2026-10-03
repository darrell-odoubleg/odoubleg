# events.odoubleg.com — O Double G Event Staffing

Recruiting + scheduling app: post gigs, crew applies, you confirm and see the schedule.

## What's inside
- Node/Express backend, SQLite database (via better-sqlite3 — no separate DB server needed)
- Public gig board, crew signup/login/dashboard, admin dashboard (post gigs, review applicants, crew directory, schedule)
- Session auth (bcrypt-hashed passwords, cookie sessions stored in SQLite)

## Deploy on your InterServer VPS (same pattern as form.franromeoagency.com)

1. Copy this folder to the VPS, e.g. `/var/www/events-odoubleg`
2. `cd /var/www/events-odoubleg && npm install`
3. Copy `.env.example` to `.env` and fill in:
   - `SESSION_SECRET` — generate with `openssl rand -hex 32`
   - `ADMIN_EMAIL` / `ADMIN_PASSWORD` — your first admin login (only used on first boot when no admin exists yet)
4. `node server.js` to test, then run it under a process manager:
   ```
   npm install -g pm2
   pm2 start server.js --name events-odoubleg
   pm2 save
   ```
5. Reverse proxy with Nginx (same as your other subdomains) pointing `events.odoubleg.com` → `localhost:3300`, with SSL via certbot.
6. Point the `events` DNS record at your VPS.

## First login
Go to `events.odoubleg.com/admin-login.html` and log in with the `ADMIN_EMAIL`/`ADMIN_PASSWORD` from your `.env`. Change that password by adding a "change password" route later, or reset it directly in the DB if needed.

## Notes / next steps you may want
- **Email notifications**: nodemailer is installed but not wired up yet. You already have Graph Mail.Send working for Fran Romeo — I can wire the same approach here so crew get an email when confirmed/declined, and you get one on new applications.
- **File uploads**: multer is installed for future use (e.g. crew headshots, certs, W9s) but not yet wired into any route.
- **Payments/contracts**: not included — this handles staffing logistics, not invoicing.
- **Multiple admins**: schema supports it; just insert additional rows into the `admins` table (hash passwords with bcrypt).
- The gig "Roles Needed" field on the admin form takes lines like `stagehand:3:25` (role:count:hourly rate).

## Local structure
```
server.js              — entry point
db/init.js              — schema + admin bootstrap
routes/                 — auth, gigs, applications, crew, schedule
middleware/auth.js      — session guards
public/                 — all frontend pages (vanilla HTML/JS, no build step)
```
