export default {
  rule: 'bank-booking-day',
  says: 'A bank row is dated on the Swedish calendar day the bank stated: a date as written, a local date-time on its own date, a date-time with an offset on the day it fell on in Stockholm.',
  home: 'src/lib/dates/iso.ts: bankBookingDay',
  why: 'The camt.053 reader kept the first ten characters of a DtTm, so a booking stamped 2026-08-31T22:01:00Z was dated 31 August although it is 00:01 on 1 September in Sweden, and lands in the previous fiscal year on a year boundary.',
  match: [
    // The date prefix of a bank's date read by hand.
    /\.match\(\/\^\(\\d\{4\}-\\d\{2\}-\\d\{2\}\)\//,
    /(?:booking|value|transaction)_?[Dd]ate\w*\??\.slice\(0, ?10\)/,
  ],
  sanctioned: ['lib/dates/iso.ts'],
  scan: ['lib/import/bank-file/', 'lib/bank-feed/', 'lib/bank-sync/', 'extensions/general/enable-banking/'],
}
