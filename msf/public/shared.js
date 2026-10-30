// Helpers shared by the schedule, kiosk, and admin pages.
const MSF = (() => {
  const CATEGORIES = [
    { id: 'grandstand', label: 'Grandstand', color: '#e4332d' },
    { id: 'music', label: 'Music', color: '#7b3fa0' },
    { id: 'rodeo', label: 'Rodeo', color: '#a0522d' },
    { id: 'livestock', label: 'Livestock', color: '#2e7d32' },
    { id: 'exhibits', label: 'Exhibits', color: '#00838f' },
    { id: 'family', label: 'Family & Kids', color: '#e07a00' },
    { id: 'food', label: 'Food', color: '#b8860b' },
    { id: 'contest', label: 'Contests', color: '#1565c0' },
    { id: 'other', label: 'Other', color: '#5f6b7a' },
  ];
  const byId = Object.fromEntries(CATEGORIES.map((c) => [c.id, c]));

  function category(id) { return byId[id] || byId.other; }

  function esc(s) {
    return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function fmtTime(t) {
    if (!t) return '';
    let [h, m] = t.split(':').map(Number);
    const ap = h >= 12 ? 'PM' : 'AM';
    h = h % 12 || 12;
    return m ? `${h}:${String(m).padStart(2, '0')} ${ap}` : `${h} ${ap}`;
  }

  function fmtRange(ev) {
    if (ev.all_day) return 'All day';
    return ev.end_time ? `${fmtTime(ev.start_time)} – ${fmtTime(ev.end_time)}` : fmtTime(ev.start_time);
  }

  function fmtDay(d, opts = { weekday: 'short', month: 'short', day: 'numeric' }) {
    return new Date(d + 'T12:00:00').toLocaleDateString('en-US', opts);
  }

  // Fair-local "now" from the server, advanced by the local clock so it stays right between fetches.
  let nowBase = null;
  function setNow(now) { nowBase = { ...now, at: Date.now() }; }
  function now() {
    if (!nowBase) {
      const d = new Date();
      return { date: d.toISOString().slice(0, 10), time: d.toTimeString().slice(0, 5) };
    }
    const [h, m] = nowBase.time.split(':').map(Number);
    let mins = h * 60 + m + Math.floor((Date.now() - nowBase.at) / 60000);
    let date = nowBase.date;
    if (mins >= 1440) {
      const d = new Date(date + 'T12:00:00Z');
      d.setUTCDate(d.getUTCDate() + Math.floor(mins / 1440));
      date = d.toISOString().slice(0, 10);
      mins %= 1440;
    }
    return { date, time: `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}` };
  }

  // Events with no end time count as "on" for 30 minutes.
  function status(ev, n = now()) {
    if (ev.cancelled) return 'cancelled';
    if (ev.date !== n.date) return ev.date < n.date ? 'past' : 'upcoming';
    if (ev.all_day) return 'now';
    const end = ev.end_time || addMinutes(ev.start_time, 30);
    if (n.time < ev.start_time) return 'upcoming';
    if (n.time < end || end < ev.start_time) return 'now';
    return 'past';
  }

  function addMinutes(t, add) {
    const [h, m] = t.split(':').map(Number);
    const mins = Math.min(h * 60 + m + add, 1439);
    return `${String(Math.floor(mins / 60)).padStart(2, '0')}:${String(mins % 60).padStart(2, '0')}`;
  }

  function where(ev) {
    return [ev.location_name, ev.location_text].filter(Boolean).join(' · ');
  }

  async function api(url, opts = {}) {
    const r = await fetch(url, {
      ...opts,
      headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) },
      body: opts.body && typeof opts.body !== 'string' ? JSON.stringify(opts.body) : opts.body,
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(data.error || `Request failed (${r.status})`), { status: r.status });
    return data;
  }

  return { CATEGORIES, category, esc, fmtTime, fmtRange, fmtDay, setNow, now, status, where, api };
})();
