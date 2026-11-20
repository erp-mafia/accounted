export default {
  rule: 'payment-order-waits-for-person',
  says: 'Whether a bank payment order waits for a person (prepared and not approved, or approved and not signed) has one answer: the supplier invoice list marker and the Att göra row "Signera N betalningar" ask paymentOrderWaitsFor.',
  home: 'src/lib/payments/orders/status.ts: paymentOrderWaitsFor',
  why: 'An open order covers its invoice whatever it waits for, and that was the only question asked: a payment an agent prepared read I betalning on its invoice and had no Att göra row, so nobody was asked to sign it (crm#1925).',
  match: [
    // .in('status', [...UNSIGNED_PAYMENT_ORDER_STATUSES]): a second read of what waits.
    /\bUNSIGNED_PAYMENT_ORDER_STATUSES\b/,
    // open_payment.payment_order.status === 'draft': the invoice's open payment read by hand.
    /payment_order\??\.status\s*[!=]==?\s*['"](?:draft|approved)['"]/,
  ],
  sanctioned: ['lib/payments/orders/status.ts', 'lib/payments/orders/unsigned-payments.ts'],
}
