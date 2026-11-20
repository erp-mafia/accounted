export default {
  rule: 'reverse-charge-rate-default',
  says: 'A supplier-invoice row under reverse charge self-assesses at its own moms sats when that is 6, 12 or 25 %, else at 25 %, never at 0, whichever way the row got there.',
  home: 'src/lib/supplier-invoices/reverse-charge-rate.ts: reverseChargeRateDefault',
  why: 'The editor set the sats by hand on one way in and left it to a react-hook-form handover on another: a row read at 0 % got a sats of 0 that the API refused, and a 12 % row self-assessed at 12 % or 25 % by the order the reading and reverse charge came in.',
  match: [
    // reverse_charge_rate ?? 0.25, reverse_charge_rate || 0.25: the default written by hand.
    /reverse_charge_rate\s*(?:\?\?|\|\|)\s*0\.25\b/,
    // reverse_charge_rate: 0.25 on a row the editor makes.
    /reverse_charge_rate\s*:\s*0\.25\b/,
  ],
  sanctioned: ['lib/supplier-invoices/reverse-charge-rate.ts'],
  // The rule is the editor's; the doors that register an invoice themselves
  // (the Inkorg's plan, the API, the booking engine) resolve a row's sats on
  // their own terms.
  scan: ['components/', 'lib/supplier-invoices/'],
}
