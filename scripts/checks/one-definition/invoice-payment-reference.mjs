export default {
  rule: 'invoice-payment-reference',
  says: 'Which reference a customer invoice asks the payer to quote (the OCR reference beside a printed giro on a Swedish invoice, else the invoice number) is chosen in one place, for the PDF, the mails, the bank-app QR, the digital mailbox and the payment_reference field of the API.',
  home: 'src/lib/invoices/ocr-reference.ts: invoicePaymentReference',
  why: 'The PDF, the bank-app QR and the mailbox each chose between the OCR and the invoice number on their own, and no API returned the choice, so an integrator had to work out the check digit to print the reference the invoice carries (crm#1886).',
  match: [/\binvoiceShowsOcrReference\(/],
  sanctioned: ['lib/invoices/ocr-reference.ts'],
}
