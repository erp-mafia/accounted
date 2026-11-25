export default {
  rule: 'supplier-invoice-attest-step',
  says: "Whether attest is a step before payment for a company's supplier invoices has one answer, companyAttestsSupplierInvoices: faktureringsmetoden with the attest policy on.",
  home: 'src/lib/supplier-invoices/lifecycle.ts: companyAttestsSupplierInvoices',
  why: 'The pages read the step from the accounting method alone and asked every faktureringsmetod company to attest before paying, while the payment file and the Att betala tab, which read the attest policy, took the same invoice unattested.',
  match: [
    // companyAttestsSupplierInvoices(method): the step read from the method alone.
    /companyAttestsSupplierInvoices\(\s*[^,()]*(?:\([^()]*\))?[^,()]*\)/,
  ],
  sanctioned: ['lib/supplier-invoices/lifecycle.ts'],
}
