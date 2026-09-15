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
  supplier_invoice: 'An invoice the company must pay: supplier, invoice number, due date, amounts, VAT. Includes payment notices and reminders for such invoices.',
  receipt: 'A receipt for a purchase already paid: merchant, date, total, VAT; often a photo of a paper receipt.',
  credit_note: 'A credit note that reduces an earlier invoice.',
  customer_invoice: 'An invoice the company has issued to a customer (a copy of its own sales invoice).',
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
  'agreement.subscription': 'Subscription or service terms the company is bound by (software, memberships, programmes with fees).',
  'agreement.other': 'Any other signed or to-be-signed agreement binding the company.',
  'registration.bolagsverket': 'A registreringsbevis or an extract issued by Bolagsverket describing the company.',
  'filing.bolagsverket': 'A form, application or notification the company sends to Bolagsverket (anmälan, ändringsanmälan).',
  'decision.skatteverket': 'A decision, registration letter or extract from Skatteverket (F-skatt, moms, arbetsgivare, fees, register extracts).',
  'minutes.board': 'Board minutes (styrelseprotokoll).',
  'minutes.agm': 'General meeting minutes (bolagsstämmoprotokoll, extra bolagsstämma).',
  share_subscription_list: 'A subscription list (teckningslista) for shares or warrants.',
  annual_report: 'An annual report (årsredovisning) or financial statements for a fiscal year.',
  other: 'Anything else. Give a short suggested_type.',
}
