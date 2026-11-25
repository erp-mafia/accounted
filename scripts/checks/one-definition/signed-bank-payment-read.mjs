export default {
  rule: 'signed-bank-payment-read',
  says: 'A bank payment signed for a supplier invoice still executes, and one read says so.',
  home: 'src/lib/payments/orders/signed-payment.ts: findSignedBankPayment',
  why: 'The link and the credit never asked, so the supplier was paid twice from the same dialog. No regex sees a door that fails to ask: this guards the read, and the door tests guard the doors.',
  match: [/\bSIGNED_PAYMENT_ORDER_STATUSES\b/],
  sanctioned: [
    'lib/payments/orders/signed-payment.ts',
    'lib/payments/orders/status.ts',
    // isSkattekontoPaymentSigned: the same reading for a payment to the
    // skattekonto, which has no invoice to read it by. Only a signed or
    // executed one pays a declaration; one at the bank unsigned never executes.
    'lib/payments/orders/skattekonto-day.ts',
  ],
}
