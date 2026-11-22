export default {
  rule: 'giro-message-length',
  says: 'A free-text payment message to a bankgiro or plusgiro is cut to the 25-position giro message field, the same text on every rail: the payment file, the Open Payments order and the bankgiro lookup.',
  home: 'src/lib/payments/supplier-payee.ts: giroMessage (GIRO_MESSAGE_MAX), applied in resolvePaymentReference',
  why: 'The file and the lookup cut the message to 25 characters on their own, the Open Payments order did not, and a 27-character invoice number was refused by the provider every time (crm#1875).',
  match: [
    // A message cut to 25 code points by hand.
    /\[\.\.\.[^\]]+\]\.slice\(\s*0\s*,\s*25\s*\)/,
    // A second constant for the giro message length.
    /\b(?:USTRD|GIRO_MESSAGE)_MAX\s*=\s*\d/,
  ],
  sanctioned: ['lib/payments/supplier-payee.ts'],
}
