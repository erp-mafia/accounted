export default {
  rule: 'skattekonto-declaration-bank-payment',
  says: 'A bank payment to the skattekonto pays a declaration when it was made after the declaration was generated, for at least its amount, paid on or before its due date, and is on its way to the bank or executed; while one does, the declaration offers no second way to pay.',
  home: 'src/lib/payments/orders/skattekonto-underway.ts: declarationBankPayment',
  why: 'Payment orders carry no link to the declaration they pay, and the salary run\'s tax panel kept offering Betala via banken and the payment file for a month whose payment was already signed and at the bank.',
  match: [
    // The due-date bound of the match written by hand.
    /requested_execution_date\s*<=\s*\w*[dD]ue/,
  ],
  sanctioned: ['lib/payments/orders/skattekonto-underway.ts'],
  allowed: {},
}
