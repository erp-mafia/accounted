export default {
  rule: 'agi-payment-due-day',
  says: 'The day a declared tax is due (the 12th, the 17th in January and August, the 26th) comes from the deadline configs, moved to a banking day; no door spells the day out.',
  home: 'src/lib/tax/deadline-config.ts: getAgiPaymentDueDate',
  why: 'The AGI payment file wrote the 12th of every month itself: the payment panel said 18 January and 14 December where the bank file said 12 January and Saturday 12 December.',
  match: [
    // `${year}-${String(month).padStart(2, '0')}-12`: a statutory day glued onto a month.
    /padStart\(2,\s*'0'\)\}-(?:12|17|26)\b/,
    // month === 0 || month === 7 ? 17 : 12: the January and August exception by hand.
    /===\s*\d+\b[^?]*\?\s*17\s*:\s*12\b/,
  ],
  sanctioned: ['lib/tax/deadline-config.ts'],
}
