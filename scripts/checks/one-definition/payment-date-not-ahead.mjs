export default {
  rule: 'payment-date-not-ahead',
  says: 'A payment recorded by hand is never dated ahead of today in Sweden.',
  home: 'src/lib/invoices/payment-date.ts: futurePaymentDateRefusal',
  why: 'One door of six refused a future date, so the same payment was booked or refused depending on the door.',
  match: [/\b(?:payment|setoff|refund)_?[dD]ate\s*>\s*(?:today\b|todayIsoStockholm\(\))/],
  sanctioned: ['lib/invoices/payment-date.ts'],
  allowed: {
    'lib/salary/payout-date.ts': 'A salary run asks and never refuses: a payment file can be scheduled at the bank ahead of the day (crm#1216).',
  },
}
