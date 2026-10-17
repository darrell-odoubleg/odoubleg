// Labor quote math, ported from the "2027 time sheet.xlsm" workbook.
// Loaded by quotes.html in the browser and required by routes/quotes.js so
// the saved totals always match what was on screen.
//
// Per person on a line (multiplied by the line's qty):
//   - each shift's hours up to midnight are regular; the part after midnight
//     (a shift whose out time is earlier than its in time) is double time
//   - regular hours past the OT threshold (40) are billed at 1.5x
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

  function calcLine(line, s) {
    const qty = Math.max(0, Number(line.qty) || 0);
    const rate = Number(line.rate) || 0;
    const shifts = (line.shifts || []).filter(sh => toHours(sh.in) != null && toHours(sh.out) != null);
    let worked = 0, dt = 0;
    for (const sh of shifts) {
      const i = toHours(sh.in), o = toHours(sh.out);
      if (o >= i) worked += o - i;
      else { worked += 24 - i; dt += o; }
    }
    const out = { qty, rate, shiftCount: shifts.length, regHours: 0, otHours: 0, dtHours: 0, reg: 0, ot: 0, dtPay: 0 };
    if (line.unit === 'day') {
      out.reg = rate * shifts.length * qty;
    } else {
      const reg = Math.min(worked, s.ot_threshold);
      const ot = Math.max(0, worked - s.ot_threshold);
      out.regHours = reg; out.otHours = ot; out.dtHours = dt;
      out.reg = reg * rate * qty;
      out.ot = ot * rate * s.ot_multiplier * qty;
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

  // quote: { lines, payroll_fee_pct, include_expenses }, s: settings object
  function calcQuote(quote, s) {
    const lines = (quote.lines || []).map(l => calcLine(l, s));
    const sum = k => round2(lines.reduce((a, l) => a + l[k], 0));
    const t = {
      lines,
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

  const api = { calcLine, calcQuote, toHours };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.QuoteCalc = api;
})(this);
