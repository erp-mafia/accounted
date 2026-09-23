/**
 * The fields a person is asked about are the ones something acts on: money
 * and dates that become expected payments and deadlines, the counterparty
 * that becomes a party link, the registrations that are checked against
 * the settings. Every other field is kept with both readings for anyone who
 * reads the record, but never queued for a person: the text of the document
 * is always there for the reader who wants the rest. Receipts and invoices
 * are booked from the Underlag reader's record, so Arkiv asks nothing.
 */
const COUNTERPARTY = (prefix: string) => [`${prefix}_name`, `${prefix}_org_number`]

export const ACTING_FIELDS: Record<string, string[]> = {
  'agreement.rental': [...COUNTERPARTY('landlord'), 'monthly_rent', 'rent_currency', 'starts_on', 'ends_on', 'notice_months', 'deposit_amount'],
  'agreement.lease': [...COUNTERPARTY('lessor'), 'monthly_fee', 'currency', 'starts_on', 'term_months', 'ends_on', 'first_payment', 'residual_value'],
  'agreement.loan': [
    ...COUNTERPARTY('lender'),
    'principal',
    'currency',
    'interest_rate',
    'interest_terms',
    'disbursed_on',
    'term_months',
    'maturity_on',
    'amortisation_free_months',
    'instalment_amount',
    'instalment_frequency',
  ],
  'agreement.subscription': [...COUNTERPARTY('provider'), 'fee_amount', 'currency', 'fee_period', 'starts_on', 'ends_on', 'notice_period', 'auto_renewal'],
  'agreement.insurance': [...COUNTERPARTY('insurer'), 'premium_amount', 'currency', 'premium_period', 'starts_on', 'ends_on', 'notice_months', 'auto_renewal'],
  'agreement.employment': ['employee_name', 'employment_form', 'ends_on'],
  'agreement.shareholder': ['ends_on'],
  'agreement.investment': [...COUNTERPARTY('investor'), 'investment_amount', 'currency', 'closing_on'],
  'agreement.customer': [...COUNTERPARTY('customer'), 'fee_amount', 'currency', 'fee_period', 'starts_on', 'ends_on', 'notice_months'],
  'agreement.other': [...COUNTERPARTY('counterparty'), 'ends_on', 'notice_months'],
  'registration.bolagsverket': ['org_number', 'company_name', 'fiscal_year'],
  'decision.skatteverket': ['org_number', 'f_skatt', 'vat_registered', 'vat_period', 'vat_method', 'employer_registered'],
}

export function actingFields(schemaType: string): Set<string> {
  return new Set(ACTING_FIELDS[schemaType] ?? [])
}
