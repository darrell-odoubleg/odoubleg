// Labor quote math, ported from the "2027 time sheet.xlsm" workbook.
// Loaded by quotes.html in the browser and required by routes/quotes.js so
// the saved totals always match what was on screen.
//
// Per person on a line (multiplied by the line's qty):
//   - after-hours double time by the quote's dt_mode: "midnight" (the
//     workbook's rule) = the part of a call after midnight, for calls whose
//     out time is earlier than their in time; "window" = any hours worked
//     inside dt_start..dt_end (e.g. 00:00-08:00, may wrap past midnight)
//   - overtime (1.5x) by the quote's ot_mode: "weekly" = regular hours past
//     ot_threshold (40) across the line, "daily" = hours past the daily
//     threshold within each call, "both" = daily first, then weekly on the
//     straight-time hours left
//   - day-rate crafts bill rate x number of shifts, no OT/DT
//   - hotel = nights x hotel rate, per diem = days x per diem rate,
//     travel = round-trip miles x mileage rate
// Payroll fee is a percentage of the labor subtotal (reg + OT + DT).
(function (root) {
  function toHours(hhmm) {
    if (!hhmm) return null;
    const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
    if (!m) return null;
    return Number(m[1]) + Number(m[2]) / 60;
  }

  function round2(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

  // Double-time hours inside a call running from i to o (hours, o may be > 24)
  function dtHoursIn(i, o, rule) {
    if (rule.mode !== 'window') return Math.max(0, o - Math.max(i, 24));
    const ws = rule.start, we = rule.end > rule.start ? rule.end : rule.end + 24;
    if (we === ws) return 0;
    let total = 0;
    for (let k = -1; k <= 1; k++) {
      const a = ws + 24 * k, b = we + 24 * k;
      total += Math.max(0, Math.min(o, b) - Math.max(i, a));
    }
    return total;
  }

  function calcLine(line, s, ot, dtRule) {
    const qty = Math.max(0, Number(line.qty) || 0);
    const rate = Number(line.rate) || 0;
    const shifts = (line.shifts || []).filter(sh => toHours(sh.in) != null && toHours(sh.out) != null);
    const daily = ot.mode === 'daily' || ot.mode === 'both';
    const weekly = ot.mode !== 'daily';
    let straight = 0, dailyOt = 0, dt = 0;
    const shiftDetail = [];
    for (const sh of shifts) {
      const i = toHours(sh.in);
      let o = toHours(sh.out);
      if (o < i) o += 24;
      const shDt = dtHoursIn(i, o, dtRule);
      let h = o - i - shDt;
      dt += shDt;
      shiftDetail.push({ date: sh.date, in: sh.in, out: sh.out, hours: round2(o - i), dtHours: round2(shDt) });
      if (daily && h > ot.dailyHours) { dailyOt += h - ot.dailyHours; h = ot.dailyHours; }
      straight += h;
    }
    const out = { shiftDetail, qty, rate, shiftCount: shifts.length, regHours: 0, otHours: 0, dtHours: 0, reg: 0, ot: 0, dtPay: 0 };
    if (line.unit === 'day') {
      out.reg = rate * shifts.length * qty;
    } else {
      const reg = weekly ? Math.min(straight, s.ot_threshold) : straight;
      const otHours = dailyOt + (straight - reg);
      out.regHours = reg; out.otHours = otHours; out.dtHours = dt;
      out.reg = reg * rate * qty;
      out.ot = otHours * rate * s.ot_multiplier * qty;
      out.dtPay = dt * rate * s.dt_multiplier * qty;
    }
    out.hotel = (Number(line.nights) || 0) * s.hotel_rate * qty;
    out.perDiem = (Number(line.perdiem_days) || 0) * s.per_diem_rate * qty;
    out.travel = (Number(line.rt_miles) || 0) * s.mileage_rate * qty;
    out.labor = out.reg + out.ot + out.dtPay;
    out.expenses = out.hotel + out.perDiem + out.travel;
    for (const k of Object.keys(out)) if (typeof out[k] === 'number') out[k] = round2(out[k]);
    return out;
  }

  function otRule(quote, s) {
    const mode = ['weekly', 'daily', 'both'].includes(quote.ot_mode) ? quote.ot_mode : 'weekly';
    const dh = Number(quote.daily_ot_hours);
    return { mode, dailyHours: quote.daily_ot_hours != null && quote.daily_ot_hours !== '' && dh > 0 ? dh : s.daily_ot_threshold };
  }

  function dtRuleFor(quote, s) {
    const mode = quote.dt_mode === 'window' ? 'window' : 'midnight';
    const start = toHours(quote.dt_start) ?? s.dt_window_start;
    const end = toHours(quote.dt_end) ?? s.dt_window_end;
    return { mode, start, end };
  }

  // quote: { lines, payroll_fee_pct, include_expenses, ot_mode, daily_ot_hours, dt_mode, dt_start, dt_end }
  // s: settings object
  function calcQuote(quote, s) {
    const ot = otRule(quote, s);
    const dtRule = dtRuleFor(quote, s);
    const lines = (quote.lines || []).map(l => calcLine(l, s, ot, dtRule));
    const sum = k => round2(lines.reduce((a, l) => a + l[k], 0));
    const t = {
      lines,
      otMode: ot.mode, dailyOtHours: ot.dailyHours, dtRule,
      people: lines.reduce((a, l) => a + l.qty, 0),
      reg: sum('reg'), ot: sum('ot'), dtPay: sum('dtPay'),
      hotel: sum('hotel'), perDiem: sum('perDiem'), travel: sum('travel'),
    };
    t.laborSubtotal = round2(t.reg + t.ot + t.dtPay);
    const feePct = quote.payroll_fee_pct != null && quote.payroll_fee_pct !== '' ? Number(quote.payroll_fee_pct) : s.payroll_fee_pct;
    t.payrollFeePct = feePct;
    t.payrollFee = round2(t.laborSubtotal * feePct / 100);
    t.totalLabor = round2(t.laborSubtotal + t.payrollFee);
    t.expenses = round2(t.hotel + t.perDiem + t.travel);
    t.includeExpenses = quote.include_expenses !== false;
    t.total = round2(t.totalLabor + (t.includeExpenses ? t.expenses : 0));
    return t;
  }

  // bill rate from crew pay: pay + markup %
  function billRate(pay, s) { return round2(pay * (1 + s.markup_pct / 100)); }

  const api = { calcLine, calcQuote, toHours, billRate };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.QuoteCalc = api;
})(this);
