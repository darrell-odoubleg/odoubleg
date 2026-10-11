require('dotenv').config();
const express = require('express');
const session = require('express-session');
const SqliteStoreFactory = require('better-sqlite3-session-store');
const SQLiteStore = SqliteStoreFactory(session);
const path = require('path');

const db = require('./db/init'); // ensures DB + tables exist, bootstraps admin

const app = express();
const PORT = process.env.PORT || 3300;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  store: new SQLiteStore({ client: db, expired: { clear: true, intervalMs: 1000 * 60 * 60 * 24 } }),
  secret: process.env.SESSION_SECRET || 'dev_secret_change_me',
  resave: false,
  saveUninitialized: false,
  cookie: {
    maxAge: 1000 * 60 * 60 * 24 * 7, // 1 week
    secure: process.env.NODE_ENV === 'production',
    httpOnly: true
  }
}));

app.use(express.static(path.join(__dirname, 'public')));

app.use('/api/auth', require('./routes/auth'));
app.use('/api/gigs', require('./routes/gigs'));
app.use('/api/applications', require('./routes/applications'));
app.use('/api/crew', require('./routes/crew'));
app.use('/api/schedule', require('./routes/schedule'));
app.use('/api/scholarships', require('./routes/scholarships'));

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`events.odoubleg.com server running on port ${PORT}`);
});
