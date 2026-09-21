/**
 * The controlled vocabulary of company facts (dev_docs/arkiv_plan.md,
 * phase 5). A predicate names one thing that is true about the company, an
 * agreement or a party; free-text predicates never exist. FIELD_PREDICATES
 * says which settled field of which extraction schema feeds which predicate,
 * and which field dates the start of its validity.
 */
export type FactSubjectKind = 'company' | 'agreement' | 'party'
export type PredicateKind = 'text' | 'amount' | 'date' | 'int' | 'percent' | 'enum' | 'orgnr'

export interface PredicateDef {
  predicate: string
  /** Swedish label for people. */
  label: string
  kind: PredicateKind
  subject: FactSubjectKind
  /** One live value at a time; a new reading supersedes the old one. */
  singleValued: boolean
}

const company = (predicate: string, label: string, kind: PredicateKind): PredicateDef => ({ predicate, label, kind, subject: 'company', singleValued: true })
const agreement = (predicate: string, label: string, kind: PredicateKind): PredicateDef => ({ predicate, label, kind, subject: 'agreement', singleValued: true })

export const PREDICATES: Record<string, PredicateDef> = Object.fromEntries(
  [
    company('legal_name', 'Registrerat namn', 'text'),
    company('org_number', 'Organisationsnummer', 'orgnr'),
    company('registered_office', 'Säte', 'text'),
    company('postal_address', 'Postadress', 'text'),
    company('registration_date', 'Registrerat', 'date'),
    company('share_capital', 'Aktiekapital', 'amount'),
    company('share_count', 'Antal aktier', 'int'),
    company('board', 'Styrelse', 'text'),
    company('signatories_rule', 'Firmateckning', 'text'),
    company('auditor', 'Revisor', 'text'),
    company('fiscal_year', 'Räkenskapsår', 'text'),
    company('business_description', 'Verksamhet', 'text'),
    company('f_skatt', 'F-skatt', 'enum'),
    company('vat_registered', 'Momsregistrerad', 'enum'),
    company('vat_period', 'Momsperiod', 'text'),
    company('vat_method', 'Redovisningsmetod', 'text'),
    company('employer_registered', 'Arbetsgivarregistrerad', 'enum'),
    agreement('counterparty_name', 'Motpart', 'text'),
    agreement('counterparty_org_number', 'Motpartens organisationsnummer', 'orgnr'),
    agreement('premises_address', 'Lokal', 'text'),
    agreement('object_description', 'Objekt', 'text'),
    agreement('service_description', 'Tjänst', 'text'),
    agreement('loan_number', 'Lånenummer', 'text'),
    agreement('amount', 'Belopp per period', 'amount'),
    agreement('currency', 'Valuta', 'text'),
    agreement('principal', 'Lånebelopp', 'amount'),
    agreement('interest_rate', 'Ränta', 'percent'),
    agreement('interest_terms', 'Räntevillkor', 'text'),
    agreement('term_months', 'Löptid i månader', 'int'),
    agreement('starts_on', 'Startdatum', 'date'),
    agreement('ends_on', 'Slutdatum', 'date'),
    agreement('notice_months', 'Uppsägningstid i månader', 'int'),
    agreement('notice_period', 'Uppsägningstid', 'text'),
    agreement('renewal_terms', 'Förlängning', 'text'),
    agreement('auto_renewal', 'Förlängs automatiskt', 'enum'),
    agreement('deposit_amount', 'Deposition', 'amount'),
    agreement('index_clause', 'Indexklausul', 'text'),
    agreement('residual_value', 'Restvärde', 'amount'),
    agreement('first_payment', 'Första förhöjd avgift', 'amount'),
    agreement('amortisation_free_months', 'Amorteringsfria månader', 'int'),
    agreement('instalment_frequency', 'Amorteringsfrekvens', 'text'),
    agreement('security', 'Säkerhet', 'text'),
    agreement('conversion_terms', 'Konverteringsvillkor', 'text'),
    agreement('fee_period', 'Betalningsperiod', 'enum'),
    agreement('signed_on', 'Undertecknat', 'date'),
  ].map((p) => [p.predicate, p]),
)

export function predicateDef(predicate: string): PredicateDef | null {
  return PREDICATES[predicate] ?? null
}

export interface FieldPredicate {
  field: string
  predicate: string
  /** The field that dates when the value starts to hold; none means unknown. */
  validFromField?: string
}

const party = (prefix: string): FieldPredicate[] => [
  { field: `${prefix}_name`, predicate: 'counterparty_name' },
  { field: `${prefix}_org_number`, predicate: 'counterparty_org_number' },
]
const same = (...fields: string[]): FieldPredicate[] => fields.map((field) => ({ field, predicate: field }))

export const FIELD_PREDICATES: Record<string, FieldPredicate[]> = {
  'registration.bolagsverket': [
    { field: 'company_name', predicate: 'legal_name' },
    { field: 'org_number', predicate: 'org_number' },
    { field: 'registered_office', predicate: 'registered_office' },
    { field: 'postal_address', predicate: 'postal_address' },
    { field: 'registration_date', predicate: 'registration_date' },
    { field: 'share_capital', predicate: 'share_capital' },
    { field: 'share_count', predicate: 'share_count' },
    { field: 'board_members', predicate: 'board' },
    { field: 'signatories_rule', predicate: 'signatories_rule' },
    { field: 'auditor', predicate: 'auditor' },
    { field: 'fiscal_year', predicate: 'fiscal_year' },
    { field: 'business_description', predicate: 'business_description' },
  ],
  'decision.skatteverket': [
    { field: 'f_skatt', predicate: 'f_skatt', validFromField: 'f_skatt_from' },
    { field: 'vat_registered', predicate: 'vat_registered', validFromField: 'vat_from' },
    { field: 'vat_period', predicate: 'vat_period' },
    { field: 'vat_method', predicate: 'vat_method' },
    { field: 'employer_registered', predicate: 'employer_registered', validFromField: 'employer_from' },
  ],
  'agreement.rental': [
    ...party('landlord'),
    ...same('premises_address', 'starts_on', 'ends_on', 'notice_months', 'renewal_terms', 'deposit_amount', 'index_clause', 'signed_on'),
    { field: 'monthly_rent', predicate: 'amount' },
    { field: 'rent_currency', predicate: 'currency' },
  ],
  'agreement.lease': [
    ...party('lessor'),
    ...same('object_description', 'currency', 'term_months', 'starts_on', 'ends_on', 'residual_value', 'first_payment', 'interest_rate', 'signed_on'),
    { field: 'monthly_fee', predicate: 'amount' },
  ],
  'agreement.loan': [
    ...party('lender'),
    ...same('principal', 'currency', 'interest_rate', 'interest_terms', 'term_months', 'amortisation_free_months', 'instalment_frequency', 'security', 'conversion_terms', 'loan_number', 'signed_on'),
    { field: 'disbursed_on', predicate: 'starts_on' },
    { field: 'maturity_on', predicate: 'ends_on' },
    { field: 'instalment_amount', predicate: 'amount' },
  ],
  'agreement.subscription': [
    ...party('provider'),
    ...same('service_description', 'currency', 'fee_period', 'starts_on', 'ends_on', 'notice_period', 'auto_renewal', 'signed_on'),
    { field: 'fee_amount', predicate: 'amount' },
  ],
}

/** Schemas whose settled fields become facts. */
export function hasFactPredicates(schemaType: string | null | undefined): boolean {
  return !!schemaType && schemaType in FIELD_PREDICATES
}
