export default {
  rule: 'invoice-marking-for-new-invoice',
  says: "A new invoice's Märkning is what the request or its source document states (an offert, a proforma, a kundorder), else the customer card's; a blank one states nothing.",
  home: 'src/lib/customers/invoice-marking.ts: invoiceMarkingForNewInvoice',
  why: "The kundorder door took the card's Märkning alone, so the marking an offert or proforma carried was lost on its way through the order to the invoice.",
  match: [
    // The card's Märkning alone, passing over what the source states.
    /\bcustomerInvoiceMarking\(/,
    /\binvoiceMarkingForNewInvoice\(\s*(?:null|undefined)\s*,/,
    // The card's field copied into a Märkning, or fallen back to, by hand.
    // Showing the card's own field is not choosing an invoice's Märkning.
    /\binvoice_marking\s*:\s*(?:[\w$]+\??\.)*customers?\??\.invoice_marking\b/,
    /(?:\?\?|\|\|)\s*(?:[\w$]+\??\.)*customers?\??\.invoice_marking\b/,
  ],
  sanctioned: ['lib/customers/invoice-marking.ts'],
  allowed: {
    'app/api/webshop-orders/[id]/create-invoice/route.ts': 'a webshop order carries no Märkning of its own: the card is the only source',
    'lib/invoices/recurring-schedule-service.ts': 'a recurring schedule carries no Märkning of its own: the card is the only source',
    'lib/invoices/editor/customer-reference.ts': "the editor's prefill: the card's Märkning is put in the field for the user to keep or clear",
    'app/(dashboard)/customers/[id]/page.tsx': "hands the card's own Märkning to the card's edit form: no invoice's Märkning is chosen here",
  },
}
