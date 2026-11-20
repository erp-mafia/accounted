export default {
  rule: 'vat-registration-needs-org-number',
  says: 'A company may be created without an organisationsnummer, but never VAT-registered without one: its momsregistreringsnummer derives from it.',
  home: 'src/lib/vat/vat-number.ts: vatRegisteredWithoutOrgNumber',
  why: 'The API and MCP schema refused the combination while the web journey relied on always having a number and createCompanyCore checked nothing, so a door that let the number go could create a VAT-registered company with no number to put on its invoices.',
  match: [
    /\b(is)?[Vv]at_?[Rr]egistered\b[^;]*&&\s*\(?\s*!\s*[\w.?]*\b(org_number|orgNumber)\b/,
    /!\s*[\w.?]*\b(org_number|orgNumber)\b[^;]*&&\s*[\w.?]*\b(is)?[Vv]at_?[Rr]egistered\b/,
  ],
  sanctioned: ['lib/vat/vat-number.ts'],
}
