export default {
  rule: 'supplier-invoice-same-document',
  says: "Whether a supplier invoice being registered is one the supplier's books already hold under its payment reference has one answer: the same invoice date, currency and amount to pay, to the öre.",
  home: 'src/lib/supplier-invoices/duplicate-lookup.ts: isSameDocumentAgain',
  why: "A supplier that prints one OCR on every invoice made the reference no signal, so the same document registered twice passed without a question; the date and the amount tell it from the next period's invoice, and a second reading of them would let one door ask and another stay quiet.",
  match: [
    // r.invoice_date === date && equalOre(r.total, total): the twin compared by hand.
    /invoice_?[dD]ate\s*===[^;]*\bequalOre\(/,
    /\bequalOre\([^;]*&&[^;]*invoice_?[dD]ate\s*===/,
  ],
  sanctioned: ['lib/supplier-invoices/duplicate-lookup.ts'],
}
