/**
 * Taxonomy v1 (dev_docs/arkiv_plan.md, section 3). Flat at the top and
 * finance-native. `other` is a first-class outcome: it carries a free-text
 * suggested type so new classes are mined from what actually arrives.
 * Labels live in messages/{sv,en}.json under `arkiv.types`.
 */
export const DOC_TYPES = [
  'supplier_invoice',
  'receipt',
  'credit_note',
  'customer_invoice',
  'bank_statement',
  'tax_account_statement',
  'agreement.lease',
  'agreement.loan',
  'agreement.rental',
  'agreement.insurance',
  'agreement.employment',
  'agreement.shareholder',
  'agreement.investment',
  'agreement.customer',
  'agreement.subscription',
  'agreement.other',
  'registration.bolagsverket',
  'filing.bolagsverket',
  'decision.skatteverket',
  'minutes.board',
  'minutes.agm',
  'share_subscription_list',
  'annual_report',
  'other',
] as const

export type DocType = (typeof DOC_TYPES)[number]

export function isDocType(value: unknown): value is DocType {
  return typeof value === 'string' && (DOC_TYPES as readonly string[]).includes(value)
}

/** Groups used by the Arkiv filters. */
export function docTypeGroup(type: DocType | null | undefined): 'agreement' | 'authority' | 'invoice_receipt' | 'minutes' | 'other' {
  if (!type) return 'other'
  if (type.startsWith('agreement.')) return 'agreement'
  if (type.startsWith('registration.') || type.startsWith('filing.') || type.startsWith('decision.')) return 'authority'
  if (type.startsWith('minutes.') || type === 'share_subscription_list' || type === 'annual_report') return 'minutes'
  if (['supplier_invoice', 'receipt', 'credit_note', 'customer_invoice', 'bank_statement', 'tax_account_statement'].includes(type)) return 'invoice_receipt'
  return 'other'
}

/** One paragraph per class, written the way the classifier reads it. */
export const DOC_TYPE_DESCRIPTIONS: Record<DocType, string> = {
  supplier_invoice: 'An invoice addressed TO the company, which the company must pay: another party is the issuer (its name, organisationsnummer and bankgiro/plusgiro are the sender\'s), the company is the recipient (Fakturamottagare, Kund, Er referens, the address block). A Swedish invoice is often headed "Faktura" or "Kundfaktura": that word names the issuer\'s customer, which is this company, so it is still a supplier_invoice. Includes payment notices and reminders for such invoices, and recurring invoices for a subscription, a lease, rent or an insurance premium.',
  receipt: 'A receipt for a purchase already paid: merchant, date, total, VAT; often a photo of a paper receipt.',
  credit_note: 'A credit note (kreditnota, kreditfaktura, credit note) that reduces an earlier invoice, from any supplier in any language.',
  customer_invoice: 'An invoice ISSUED BY the company to its own customer: the company\'s name and organisationsnummer stand as the issuer and its bankgiro/plusgiro is where the money goes; the recipient is somebody else. Never chosen because the document is headed "Kundfaktura" or because the company is named as the customer on it: that is a supplier_invoice.',
  bank_statement: 'A statement from a bank listing transactions on an account over a period.',
  tax_account_statement: 'A skattekonto statement from Skatteverket listing tax account transactions.',
  'agreement.lease': 'A leasing contract for equipment or a vehicle: lessor, object, monthly fee, term, residual value.',
  'agreement.loan': 'A loan, credit or convertible loan agreement or promissory note (skuldebrev): lender, principal, interest, repayment, security. A payment notice (avi), interest statement or account statement for a loan is not the agreement: classify it as other.',
  'agreement.rental': 'A rental contract for premises (hyresavtal lokal): landlord, rent, term, notice period, indexation.',
  'agreement.insurance': 'An insurance policy or letter (försäkringsbrev): insurer, cover, premium, period.',
  'agreement.employment': 'An employment contract: employee, salary, start date, terms.',
  'agreement.shareholder': 'A shareholders agreement or an adherence agreement to one.',
  'agreement.investment': 'An investment or subscription agreement for a share issue, or an adherence agreement to one.',
  'agreement.customer': 'A contract where the company is the seller: the other party buys the company\'s goods or services. A programme, service or membership the company itself pays for is agreement.subscription or agreement.other.',
  'agreement.subscription': 'Subscription or service terms the company is bound by (software, memberships, programmes with fees): an order form, terms of service or a signed subscription contract. An invoice or receipt for a subscription period is not the agreement: classify it as supplier_invoice or receipt.',
  'agreement.other': 'Any other signed or to-be-signed agreement binding the company.',
  'registration.bolagsverket': 'A registreringsbevis or an extract issued by Bolagsverket describing the company.',
  'filing.bolagsverket': 'A form, application or notification the company sends to Bolagsverket (anmälan, ändringsanmälan).',
  'decision.skatteverket': 'A decision, registration letter or extract from Skatteverket (F-skatt, moms, arbetsgivare, register extracts) with nothing to pay on it. A bill to pay from an authority is a supplier_invoice.',
  'minutes.board': 'Board minutes (styrelseprotokoll).',
  'minutes.agm': 'General meeting minutes (bolagsstämmoprotokoll, extra bolagsstämma).',
  share_subscription_list: 'A subscription list (teckningslista) for shares or warrants.',
  annual_report: 'An annual report (årsredovisning) or financial statements for a fiscal year.',
  other: 'Anything else. Give a short suggested_type.',
}
