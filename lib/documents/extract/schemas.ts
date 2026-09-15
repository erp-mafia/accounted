import type { DocType } from '@/lib/documents/classify/taxonomy'

/**
 * Extraction schemas, version 1 (dev_docs/arkiv_plan.md, phase 3). One
 * schema per type for the six first types, a small generic one for the rest.
 * Every field is grounded: the model returns the value, the page it read it
 * from, and a short verbatim quote; the reading layer's word boxes turn the
 * quote into a region. Kinds drive normalisation, comparison and checks.
 */
export type FieldKind = 'text' | 'amount' | 'date' | 'orgnr' | 'int' | 'percent' | 'enum'

export interface FieldDef {
  name: string
  kind: FieldKind
  description: string
  required?: boolean
  /** For enum kinds. */
  options?: string[]
}

export interface ExtractionSchemaDef {
  schemaType: string
  version: number
  /** What the reader is looking at, in one sentence, for the prompt. */
  subject: string
  fields: FieldDef[]
  /** Words that mark the pages worth sending for long documents. */
  keywords: string[]
}

const party = (prefix: string, label: string): FieldDef[] => [
  { name: `${prefix}_name`, kind: 'text', description: `Name of the ${label}.`, required: true },
  { name: `${prefix}_org_number`, kind: 'orgnr', description: `Swedish organisation number of the ${label}, if printed.` },
]

export const SCHEMAS: Record<string, ExtractionSchemaDef> = {
  'agreement.rental': {
    schemaType: 'agreement.rental',
    version: 1,
    subject: 'a rental contract for premises (hyresavtal lokal)',
    keywords: ['hyra', 'hyran', 'uppsägning', 'avtalstid', 'index', 'deposition', 'säkerhet', 'underskrift'],
    fields: [
      ...party('landlord', 'landlord (hyresvärd)'),
      { name: 'premises_address', kind: 'text', description: 'Address or designation of the premises.' },
      { name: 'monthly_rent', kind: 'amount', description: 'Rent per month excluding VAT, as a number.', required: true },
      { name: 'rent_currency', kind: 'text', description: 'Currency of the rent, ISO code (SEK if kronor).' },
      { name: 'rent_includes_vat', kind: 'enum', options: ['yes', 'no', 'unknown'], description: 'Whether the stated rent includes VAT.' },
      { name: 'starts_on', kind: 'date', description: 'Start of the contract term, YYYY-MM-DD.', required: true },
      { name: 'ends_on', kind: 'date', description: 'End of the current term, YYYY-MM-DD.' },
      { name: 'notice_months', kind: 'int', description: 'Notice period in months.' },
      { name: 'renewal_terms', kind: 'text', description: 'How the contract renews if not terminated (e.g. 3 years at a time).' },
      { name: 'deposit_amount', kind: 'amount', description: 'Deposit or bank guarantee amount.' },
      { name: 'index_clause', kind: 'text', description: 'Indexation clause (e.g. KPI October).' },
      { name: 'signed_on', kind: 'date', description: 'Date of the last signature, YYYY-MM-DD.' },
    ],
  },
  'agreement.lease': {
    schemaType: 'agreement.lease',
    version: 1,
    subject: 'a leasing contract for equipment or a vehicle',
    keywords: ['leasing', 'leasingavgift', 'restvärde', 'löptid', 'objekt', 'ränta', 'underskrift'],
    fields: [
      ...party('lessor', 'lessor (leasegivare)'),
      { name: 'object_description', kind: 'text', description: 'The leased object, including registration number if a vehicle.', required: true },
      { name: 'monthly_fee', kind: 'amount', description: 'Leasing fee per month excluding VAT.', required: true },
      { name: 'currency', kind: 'text', description: 'Currency, ISO code.' },
      { name: 'term_months', kind: 'int', description: 'Term in months.' },
      { name: 'starts_on', kind: 'date', description: 'Start date, YYYY-MM-DD.' },
      { name: 'ends_on', kind: 'date', description: 'End date, YYYY-MM-DD.' },
      { name: 'residual_value', kind: 'amount', description: 'Residual value at the end of the term.' },
      { name: 'first_payment', kind: 'amount', description: 'Initial or extra first payment.' },
      { name: 'interest_rate', kind: 'percent', description: 'Interest rate in percent, if stated.' },
      { name: 'signed_on', kind: 'date', description: 'Date of the last signature.' },
    ],
  },
  'agreement.loan': {
    schemaType: 'agreement.loan',
    version: 1,
    subject: 'a loan, credit or convertible loan agreement or promissory note (skuldebrev)',
    keywords: ['lån', 'kredit', 'ränta', 'amortering', 'förfall', 'säkerhet', 'pant', 'borgen', 'konvertering', 'skuldebrev', 'underskrift'],
    fields: [
      ...party('lender', 'lender (långivare)'),
      { name: 'principal', kind: 'amount', description: 'Principal amount of the loan.', required: true },
      { name: 'currency', kind: 'text', description: 'Currency, ISO code.' },
      { name: 'interest_rate', kind: 'percent', description: 'Annual interest rate in percent.' },
      { name: 'interest_terms', kind: 'text', description: 'How interest is set and paid (fixed, base rate plus margin, compounded, monthly).' },
      { name: 'term_months', kind: 'int', description: 'Term in months.' },
      { name: 'disbursed_on', kind: 'date', description: 'Disbursement or agreement date, YYYY-MM-DD.' },
      { name: 'maturity_on', kind: 'date', description: 'Final repayment date, YYYY-MM-DD.' },
      { name: 'amortisation_free_months', kind: 'int', description: 'Number of amortisation-free months at the start.' },
      { name: 'instalment_amount', kind: 'amount', description: 'Regular amortisation instalment amount.' },
      { name: 'instalment_frequency', kind: 'text', description: 'How often instalments fall due.' },
      { name: 'security', kind: 'text', description: 'Security, pledges or guarantees.' },
      { name: 'conversion_terms', kind: 'text', description: 'Conversion terms for a convertible loan (trigger, discount, cap).' },
      { name: 'loan_number', kind: 'text', description: 'Loan or credit number, if printed.' },
      { name: 'signed_on', kind: 'date', description: 'Date of the last signature.' },
    ],
  },
  'agreement.subscription': {
    schemaType: 'agreement.subscription',
    version: 1,
    subject: 'subscription or service terms the company is bound by',
    keywords: ['abonnemang', 'prenumeration', 'avgift', 'uppsägning', 'bindningstid', 'förnyelse', 'pris'],
    fields: [
      ...party('provider', 'provider'),
      { name: 'service_description', kind: 'text', description: 'What is subscribed to.', required: true },
      { name: 'fee_amount', kind: 'amount', description: 'Fee per period excluding VAT.' },
      { name: 'currency', kind: 'text', description: 'Currency, ISO code.' },
      { name: 'fee_period', kind: 'enum', options: ['monthly', 'quarterly', 'yearly', 'one_time', 'unknown'], description: 'Billing period.' },
      { name: 'starts_on', kind: 'date', description: 'Start date, YYYY-MM-DD.' },
      { name: 'ends_on', kind: 'date', description: 'End of the binding period, YYYY-MM-DD.' },
      { name: 'notice_period', kind: 'text', description: 'Notice period.' },
      { name: 'auto_renewal', kind: 'enum', options: ['yes', 'no', 'unknown'], description: 'Whether it renews automatically.' },
      { name: 'signed_on', kind: 'date', description: 'Date of signature or acceptance.' },
    ],
  },
  'registration.bolagsverket': {
    schemaType: 'registration.bolagsverket',
    version: 1,
    subject: 'a registreringsbevis or extract from Bolagsverket',
    keywords: ['organisationsnummer', 'säte', 'aktiekapital', 'styrelse', 'firmateckning', 'revisor', 'räkenskapsår', 'verksamhet'],
    fields: [
      { name: 'org_number', kind: 'orgnr', description: 'Organisationsnummer of the company.', required: true },
      { name: 'company_name', kind: 'text', description: 'Registered company name.', required: true },
      { name: 'registered_office', kind: 'text', description: 'Säte (municipality and county).' },
      { name: 'postal_address', kind: 'text', description: 'Registered postal address.' },
      { name: 'registration_date', kind: 'date', description: 'Date the company was registered, YYYY-MM-DD.' },
      { name: 'share_capital', kind: 'amount', description: 'Registered share capital.' },
      { name: 'share_count', kind: 'int', description: 'Number of shares.' },
      { name: 'board_members', kind: 'text', description: 'Board members and deputies with roles, separated by semicolons.' },
      { name: 'signatories_rule', kind: 'text', description: 'Firmateckning: who may sign for the company.' },
      { name: 'auditor', kind: 'text', description: 'Registered auditor, or none.' },
      { name: 'fiscal_year', kind: 'text', description: 'Räkenskapsår as printed.' },
      { name: 'business_description', kind: 'text', description: 'Verksamhet as printed.' },
      { name: 'issued_on', kind: 'date', description: 'Date the extract was issued, YYYY-MM-DD.' },
      { name: 'case_number', kind: 'text', description: 'Ärendenummer, if printed.' },
    ],
  },
  'decision.skatteverket': {
    schemaType: 'decision.skatteverket',
    version: 1,
    subject: 'a decision, registration letter or register extract from Skatteverket',
    keywords: ['f-skatt', 'moms', 'arbetsgivare', 'registrerad', 'beslut', 'avgift', 'redovisningsperiod', 'organisationsnummer'],
    fields: [
      { name: 'decision_type', kind: 'text', description: 'What the letter is (registerutdrag, beslut om F-skatt, förseningsavgift, momsregistrering).', required: true },
      { name: 'org_number', kind: 'orgnr', description: 'Organisationsnummer the decision concerns.' },
      { name: 'decision_date', kind: 'date', description: 'Date of the letter, YYYY-MM-DD.' },
      { name: 'f_skatt', kind: 'enum', options: ['approved', 'not_approved', 'unknown'], description: 'F-skatt status.' },
      { name: 'f_skatt_from', kind: 'date', description: 'F-skatt valid from, YYYY-MM-DD.' },
      { name: 'vat_registered', kind: 'enum', options: ['yes', 'no', 'unknown'], description: 'Registered for VAT.' },
      { name: 'vat_from', kind: 'date', description: 'VAT registration valid from, YYYY-MM-DD.' },
      { name: 'vat_period', kind: 'text', description: 'VAT reporting period (månad, kvartal, helt beskattningsår).' },
      { name: 'vat_method', kind: 'text', description: 'Redovisningsmetod (faktureringsmetoden or bokslutsmetoden).' },
      { name: 'employer_registered', kind: 'enum', options: ['yes', 'no', 'unknown'], description: 'Registered as employer.' },
      { name: 'employer_from', kind: 'date', description: 'Employer registration valid from, YYYY-MM-DD.' },
      { name: 'amount', kind: 'amount', description: 'Amount decided, if the letter is about a fee or tax.' },
      { name: 'reference', kind: 'text', description: 'Reference or case number.' },
    ],
  },
  generic: {
    schemaType: 'generic',
    version: 1,
    subject: 'a business document',
    keywords: [],
    fields: [
      ...party('counterparty', 'other party'),
      { name: 'document_date', kind: 'date', description: 'Date of the document, YYYY-MM-DD.' },
      { name: 'total_amount', kind: 'amount', description: 'The main amount, if any.' },
      { name: 'currency', kind: 'text', description: 'Currency, ISO code.' },
      { name: 'key_terms', kind: 'text', description: 'The three to five most important terms or facts, in one sentence each, separated by semicolons.' },
    ],
  },
}

/** The schema that reads a document of this type: a dedicated one for the six first types, the generic one otherwise. */
export function schemaForType(docType: DocType | string | null | undefined): ExtractionSchemaDef {
  return (docType && SCHEMAS[docType]) || SCHEMAS.generic
}

/** JSON schema for the forced tool call: every field is {value, page, quote}. */
export function jsonSchemaFor(def: ExtractionSchemaDef): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  for (const f of def.fields) {
    const valueSchema =
      f.kind === 'amount' || f.kind === 'percent' || f.kind === 'int'
        ? { type: ['number', 'null'] }
        : f.kind === 'enum'
          ? { type: ['string', 'null'], enum: [...(f.options ?? []), null] }
          : { type: ['string', 'null'] }
    properties[f.name] = {
      type: 'object',
      additionalProperties: false,
      required: ['value', 'page', 'quote'],
      properties: {
        value: { ...valueSchema, description: f.description },
        page: { type: ['integer', 'null'], description: 'The 1-based page the value was read from.' },
        quote: { type: ['string', 'null'], description: 'Up to twelve words copied verbatim from that page around the value.' },
      },
    }
  }
  return { type: 'object', additionalProperties: false, required: def.fields.map((f) => f.name), properties }
}

export function fieldKinds(def: ExtractionSchemaDef): Record<string, FieldKind> {
  return Object.fromEntries(def.fields.map((f) => [f.name, f.kind]))
}
