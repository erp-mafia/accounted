import type { DocType } from '@/lib/documents/classify/taxonomy'

/**
 * Extraction schemas, version 1 (dev_docs/arkiv_plan.md, phases 3 and 6).
 * One schema per document type, a small generic one for `other`.
 * Every field is grounded: the model returns the value, the page it read it
 * from and a short verbatim quote; the reading layer's word boxes turn the
 * quote into a region. Kinds drive normalisation, comparison and checks.
 *
 * text is a short name or identifier, compared ignoring case and punctuation.
 * prose is descriptive text that two readings never word alike; they agree
 * when both found it. An enum has no "unknown" option: null means the
 * document does not say.
 */
export type FieldKind = 'text' | 'prose' | 'amount' | 'date' | 'orgnr' | 'int' | 'percent' | 'enum'

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
  /** What the reader is looking at, in one phrase, for the prompt. */
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
      { name: 'rent_includes_vat', kind: 'enum', options: ['yes', 'no'], description: 'Whether the stated rent includes VAT.' },
      { name: 'starts_on', kind: 'date', description: 'Start of the contract term, YYYY-MM-DD.', required: true },
      { name: 'ends_on', kind: 'date', description: 'End of the current term, YYYY-MM-DD.' },
      { name: 'notice_months', kind: 'int', description: 'Notice period in months.' },
      { name: 'renewal_terms', kind: 'prose', description: 'How the contract renews if not terminated (e.g. 3 years at a time).' },
      { name: 'deposit_amount', kind: 'amount', description: 'Deposit or bank guarantee amount.' },
      { name: 'index_clause', kind: 'prose', description: 'Indexation clause (e.g. KPI October).' },
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
      { name: 'object_description', kind: 'prose', description: 'The leased object, including registration number if a vehicle.', required: true },
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
      { name: 'interest_terms', kind: 'prose', description: 'How interest is set and paid (fixed, base rate plus margin, compounded, monthly).' },
      { name: 'term_months', kind: 'int', description: 'Term in months.' },
      { name: 'disbursed_on', kind: 'date', description: 'Disbursement or agreement date, YYYY-MM-DD.' },
      { name: 'maturity_on', kind: 'date', description: 'Final repayment date, YYYY-MM-DD.' },
      { name: 'amortisation_free_months', kind: 'int', description: 'Number of amortisation-free months at the start.' },
      { name: 'instalment_amount', kind: 'amount', description: 'Regular amortisation instalment amount.' },
      { name: 'instalment_frequency', kind: 'prose', description: 'How often instalments fall due.' },
      { name: 'security', kind: 'prose', description: 'Security, pledges or guarantees.' },
      { name: 'conversion_terms', kind: 'prose', description: 'Conversion terms for a convertible loan (trigger, discount, cap).' },
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
      { name: 'service_description', kind: 'prose', description: 'What is subscribed to.', required: true },
      { name: 'fee_amount', kind: 'amount', description: 'Fee per period excluding VAT.' },
      { name: 'currency', kind: 'text', description: 'Currency, ISO code.' },
      { name: 'fee_period', kind: 'enum', options: ['monthly', 'quarterly', 'yearly', 'one_time'], description: 'Billing period.' },
      { name: 'starts_on', kind: 'date', description: 'Start date, YYYY-MM-DD.' },
      { name: 'ends_on', kind: 'date', description: 'End of the binding period, YYYY-MM-DD.' },
      { name: 'notice_period', kind: 'prose', description: 'Notice period.' },
      { name: 'auto_renewal', kind: 'enum', options: ['yes', 'no'], description: 'Whether it renews automatically.' },
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
      { name: 'board_members', kind: 'prose', description: 'Board members and deputies with roles, separated by semicolons.' },
      { name: 'signatories_rule', kind: 'prose', description: 'Firmateckning: who may sign for the company.' },
      { name: 'auditor', kind: 'text', description: 'Registered auditor, or null when none is registered.' },
      { name: 'fiscal_year', kind: 'text', description: 'Räkenskapsår as printed.' },
      { name: 'business_description', kind: 'prose', description: 'Verksamhet as printed.' },
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
      { name: 'decision_type', kind: 'prose', description: 'What the letter is (registerutdrag, beslut om F-skatt, förseningsavgift, momsregistrering).', required: true },
      { name: 'org_number', kind: 'orgnr', description: 'Organisationsnummer the decision concerns.' },
      { name: 'decision_date', kind: 'date', description: 'Date of the letter, YYYY-MM-DD.' },
      { name: 'f_skatt', kind: 'enum', options: ['approved', 'not_approved'], description: 'F-skatt status.' },
      { name: 'f_skatt_from', kind: 'date', description: 'F-skatt valid from, YYYY-MM-DD.' },
      { name: 'vat_registered', kind: 'enum', options: ['yes', 'no'], description: 'Registered for VAT.' },
      { name: 'vat_from', kind: 'date', description: 'VAT registration valid from, YYYY-MM-DD.' },
      { name: 'vat_period', kind: 'prose', description: 'VAT reporting period (månad, kvartal, helt beskattningsår).' },
      { name: 'vat_method', kind: 'prose', description: 'Redovisningsmetod (faktureringsmetoden or bokslutsmetoden).' },
      { name: 'employer_registered', kind: 'enum', options: ['yes', 'no'], description: 'Registered as employer.' },
      { name: 'employer_from', kind: 'date', description: 'Employer registration valid from, YYYY-MM-DD.' },
      { name: 'amount', kind: 'amount', description: 'Amount decided, if the letter is about a fee or tax.' },
      { name: 'reference', kind: 'text', description: 'Reference or case number.' },
    ],
  },
  'agreement.insurance': {
    schemaType: 'agreement.insurance',
    version: 1,
    subject: 'an insurance policy or letter (försäkringsbrev)',
    keywords: ['försäkring', 'premie', 'självrisk', 'försäkringsperiod', 'omfattning', 'uppsägning', 'förnyelse'],
    fields: [
      ...party('insurer', 'insurer (försäkringsgivare)'),
      { name: 'policy_number', kind: 'text', description: 'Policy or insurance number.' },
      { name: 'cover_description', kind: 'prose', description: 'What is insured and the main cover (e.g. företagsförsäkring, egendom, ansvar).', required: true },
      { name: 'premium_amount', kind: 'amount', description: 'Premium per period.' },
      { name: 'currency', kind: 'text', description: 'Currency, ISO code.' },
      { name: 'premium_period', kind: 'enum', options: ['monthly', 'quarterly', 'yearly', 'one_time'], description: 'How often the premium is paid.' },
      { name: 'deductible_amount', kind: 'amount', description: 'Deductible (självrisk) if stated.' },
      { name: 'starts_on', kind: 'date', description: 'Start of the insurance period, YYYY-MM-DD.' },
      { name: 'ends_on', kind: 'date', description: 'End of the insurance period, YYYY-MM-DD.' },
      { name: 'notice_months', kind: 'int', description: 'Notice period in months, if stated.' },
      { name: 'auto_renewal', kind: 'enum', options: ['yes', 'no'], description: 'Whether the policy renews automatically.' },
      { name: 'signed_on', kind: 'date', description: 'Date of the letter or signature.' },
    ],
  },
  'agreement.employment': {
    schemaType: 'agreement.employment',
    version: 1,
    subject: 'an employment contract (anställningsavtal)',
    keywords: ['anställning', 'lön', 'tillträde', 'uppsägningstid', 'provanställning', 'semester', 'arbetstid', 'kollektivavtal'],
    fields: [
      { name: 'employee_name', kind: 'text', description: 'Name of the employee. Never a personal identity number.', required: true },
      { name: 'role_title', kind: 'text', description: 'Position or title.' },
      {
        name: 'employment_form',
        kind: 'enum',
        options: ['permanent', 'fixed_term', 'probation', 'hourly'],
        description: 'Form of employment (tillsvidare, visstid, provanställning, timanställning).',
      },
      { name: 'starts_on', kind: 'date', description: 'First day of employment, YYYY-MM-DD.' },
      { name: 'ends_on', kind: 'date', description: 'Last day for a fixed term or probation, YYYY-MM-DD.' },
      { name: 'monthly_salary', kind: 'amount', description: 'Monthly salary before tax.' },
      { name: 'currency', kind: 'text', description: 'Currency, ISO code.' },
      { name: 'hours_per_week', kind: 'amount', description: 'Working hours per week.' },
      { name: 'vacation_days', kind: 'int', description: 'Vacation days per year.' },
      { name: 'notice_months', kind: 'int', description: 'Notice period in months.' },
      { name: 'collective_agreement', kind: 'prose', description: 'Collective agreement that applies, if any.' },
      { name: 'signed_on', kind: 'date', description: 'Date of the last signature.' },
    ],
  },
  'agreement.shareholder': {
    schemaType: 'agreement.shareholder',
    version: 1,
    subject: 'a shareholders agreement (aktieägaravtal) or an adherence agreement to one',
    keywords: ['aktieägaravtal', 'shareholders', 'hembud', 'förköp', 'drag', 'tag', 'styrelse', 'överlåtelse', 'adherence', 'anslutning'],
    fields: [
      { name: 'company_name', kind: 'text', description: 'The company the agreement concerns.' },
      { name: 'parties_summary', kind: 'prose', description: 'The shareholders that are parties, with holdings if stated.', required: true },
      { name: 'transfer_restrictions', kind: 'prose', description: 'Restrictions on transferring shares (hembud, förköp, samtycke).' },
      { name: 'drag_along', kind: 'enum', options: ['yes', 'no'], description: 'Whether a drag-along clause exists.' },
      { name: 'tag_along', kind: 'enum', options: ['yes', 'no'], description: 'Whether a tag-along clause exists.' },
      { name: 'board_composition', kind: 'prose', description: 'How the board is appointed.' },
      { name: 'reserved_matters', kind: 'prose', description: 'Decisions that need a qualified majority or consent.' },
      { name: 'effective_on', kind: 'date', description: 'Date the agreement takes effect, YYYY-MM-DD.' },
      { name: 'ends_on', kind: 'date', description: 'End date or term, YYYY-MM-DD, if stated.' },
      { name: 'signed_on', kind: 'date', description: 'Date of the last signature.' },
    ],
  },
  'agreement.investment': {
    schemaType: 'agreement.investment',
    version: 1,
    subject: 'an investment or share subscription agreement, or an adherence agreement to one',
    keywords: ['investering', 'teckning', 'aktier', 'emission', 'värdering', 'pre-money', 'tillträde', 'closing', 'investment', 'subscription'],
    fields: [
      ...party('investor', 'investor'),
      { name: 'investment_amount', kind: 'amount', description: 'Amount invested.', required: true },
      { name: 'currency', kind: 'text', description: 'Currency, ISO code.' },
      { name: 'share_count', kind: 'int', description: 'Number of shares subscribed.' },
      { name: 'price_per_share', kind: 'amount', description: 'Subscription price per share.' },
      { name: 'pre_money_valuation', kind: 'amount', description: 'Pre-money valuation, if stated.' },
      { name: 'closing_on', kind: 'date', description: 'Closing or payment date, YYYY-MM-DD.' },
      { name: 'conditions', kind: 'prose', description: 'Conditions precedent or special terms.' },
      { name: 'signed_on', kind: 'date', description: 'Date of the last signature.' },
    ],
  },
  'agreement.customer': {
    schemaType: 'agreement.customer',
    version: 1,
    subject: "a contract with a customer for the company's own sales or services",
    keywords: ['kund', 'uppdrag', 'leverans', 'arvode', 'pris', 'fakturering', 'uppsägning', 'avtalstid'],
    fields: [
      ...party('customer', 'customer'),
      { name: 'service_description', kind: 'prose', description: 'What the company delivers.', required: true },
      { name: 'fee_amount', kind: 'amount', description: 'Fee per period, excluding VAT.' },
      { name: 'currency', kind: 'text', description: 'Currency, ISO code.' },
      { name: 'fee_period', kind: 'enum', options: ['monthly', 'quarterly', 'yearly', 'one_time'], description: 'How often the fee is invoiced.' },
      { name: 'starts_on', kind: 'date', description: 'Start date, YYYY-MM-DD.' },
      { name: 'ends_on', kind: 'date', description: 'End date, YYYY-MM-DD.' },
      { name: 'notice_months', kind: 'int', description: 'Notice period in months.' },
      { name: 'signed_on', kind: 'date', description: 'Date of the last signature.' },
    ],
  },
  'agreement.other': {
    schemaType: 'agreement.other',
    version: 1,
    subject: 'a signed agreement binding the company',
    keywords: ['avtal', 'parter', 'avtalstid', 'uppsägning', 'ersättning', 'underskrift'],
    fields: [
      ...party('counterparty', 'other party'),
      { name: 'subject', kind: 'prose', description: 'What the agreement is about, in one or two sentences.', required: true },
      { name: 'amount', kind: 'amount', description: 'The main amount, if any.' },
      { name: 'currency', kind: 'text', description: 'Currency, ISO code.' },
      { name: 'starts_on', kind: 'date', description: 'Start date, YYYY-MM-DD.' },
      { name: 'ends_on', kind: 'date', description: 'End date, YYYY-MM-DD.' },
      { name: 'notice_months', kind: 'int', description: 'Notice period in months.' },
      { name: 'signed_on', kind: 'date', description: 'Date of the last signature.' },
    ],
  },
  'minutes.board': {
    schemaType: 'minutes.board',
    version: 1,
    subject: 'board minutes (styrelseprotokoll)',
    keywords: ['styrelseprotokoll', 'styrelsemöte', 'beslut', 'närvarande', 'ordförande', 'justeras', 'protokollförare'],
    fields: [
      { name: 'meeting_date', kind: 'date', description: 'Date of the meeting, YYYY-MM-DD.', required: true },
      { name: 'meeting_number', kind: 'text', description: 'Meeting or minutes number, if any.' },
      { name: 'chair', kind: 'text', description: 'Chair of the meeting.' },
      { name: 'attendees', kind: 'prose', description: 'Who attended, separated by semicolons.' },
      { name: 'decisions', kind: 'prose', description: 'Every decision taken, one sentence each, separated by semicolons.', required: true },
      { name: 'signed_on', kind: 'date', description: 'Date the minutes were signed, YYYY-MM-DD.' },
    ],
  },
  'minutes.agm': {
    schemaType: 'minutes.agm',
    version: 1,
    subject: 'general meeting minutes (bolagsstämmoprotokoll)',
    keywords: ['bolagsstämma', 'årsstämma', 'extra bolagsstämma', 'beslut', 'utdelning', 'styrelse', 'revisor', 'ansvarsfrihet', 'emission', 'teckningsoptioner'],
    fields: [
      { name: 'meeting_date', kind: 'date', description: 'Date of the meeting, YYYY-MM-DD.', required: true },
      { name: 'meeting_kind', kind: 'enum', options: ['agm', 'extra'], description: 'Årsstämma or extra bolagsstämma.' },
      { name: 'chair', kind: 'text', description: 'Chair of the meeting.' },
      { name: 'attendees', kind: 'prose', description: 'Shareholders present and their votes, if listed.' },
      { name: 'decisions', kind: 'prose', description: 'Every decision taken, one sentence each, separated by semicolons.', required: true },
      { name: 'dividend_amount', kind: 'amount', description: 'Dividend decided, total amount.' },
      { name: 'board_elected', kind: 'prose', description: 'Board members elected, if any, with roles.' },
      { name: 'auditor_elected', kind: 'text', description: 'Auditor elected, if any.' },
      { name: 'signed_on', kind: 'date', description: 'Date the minutes were signed, YYYY-MM-DD.' },
    ],
  },
  share_subscription_list: {
    schemaType: 'share_subscription_list',
    version: 1,
    subject: 'a subscription list (teckningslista) for shares or warrants',
    keywords: ['teckningslista', 'teckning', 'teckningskurs', 'aktier', 'teckningsoptioner', 'emission', 'betalning'],
    fields: [
      ...party('issuer', 'issuing company'),
      { name: 'instrument', kind: 'enum', options: ['shares', 'warrants', 'convertibles'], description: 'What is subscribed.' },
      { name: 'decision_date', kind: 'date', description: 'Date of the issue decision, YYYY-MM-DD.' },
      { name: 'subscription_period_start', kind: 'date', description: 'Subscription period start, YYYY-MM-DD.' },
      { name: 'subscription_period_end', kind: 'date', description: 'Subscription period end, YYYY-MM-DD.' },
      { name: 'price_per_share', kind: 'amount', description: 'Subscription price per share or warrant.' },
      { name: 'quantity_offered', kind: 'int', description: 'Number offered.' },
      { name: 'total_amount', kind: 'amount', description: 'Total subscription amount, if stated.' },
      { name: 'subscribers', kind: 'prose', description: 'Subscribers with quantities, separated by semicolons.' },
    ],
  },
  annual_report: {
    schemaType: 'annual_report',
    version: 1,
    subject: 'an annual report (årsredovisning) or annual accounts',
    keywords: ['årsredovisning', 'förvaltningsberättelse', 'resultaträkning', 'balansräkning', 'nettoomsättning', 'eget kapital', 'revisionsberättelse', 'räkenskapsår'],
    fields: [
      { name: 'fiscal_year_start', kind: 'date', description: 'First day of the fiscal year, YYYY-MM-DD.', required: true },
      { name: 'fiscal_year_end', kind: 'date', description: 'Last day of the fiscal year, YYYY-MM-DD.', required: true },
      { name: 'revenue', kind: 'amount', description: 'Net revenue (nettoomsättning) for the year.' },
      { name: 'operating_result', kind: 'amount', description: 'Operating result (rörelseresultat).' },
      { name: 'net_result', kind: 'amount', description: 'Result for the year (årets resultat).' },
      { name: 'total_assets', kind: 'amount', description: 'Balance sheet total.' },
      { name: 'equity', kind: 'amount', description: 'Total equity at year end.' },
      { name: 'employees_average', kind: 'amount', description: 'Average number of employees.' },
      { name: 'auditor_report', kind: 'enum', options: ['yes', 'no'], description: 'Whether an audit report (revisionsberättelse) is included.' },
      { name: 'board_signatures', kind: 'prose', description: 'Who signed the report and when.' },
      { name: 'signed_on', kind: 'date', description: 'Date of signature, YYYY-MM-DD.' },
    ],
  },
  'filing.bolagsverket': {
    schemaType: 'filing.bolagsverket',
    version: 1,
    subject: 'a notification or application the company sends to Bolagsverket',
    keywords: ['anmälan', 'ändringsanmälan', 'bolagsverket', 'ärende', 'avgift', 'styrelse', 'företrädare', 'bolagsordning'],
    fields: [
      { name: 'filing_type', kind: 'prose', description: 'What is filed (e.g. ändringsanmälan, nyemission, ändrad styrelse).', required: true },
      { name: 'org_number', kind: 'orgnr', description: 'Organisationsnummer of the company.' },
      { name: 'case_number', kind: 'text', description: 'Ärendenummer, if any.' },
      { name: 'filed_on', kind: 'date', description: 'Date filed or signed, YYYY-MM-DD.' },
      { name: 'changes_summary', kind: 'prose', description: 'The changes notified, one sentence each, separated by semicolons.' },
      { name: 'fee_amount', kind: 'amount', description: 'Fee to Bolagsverket, if stated.' },
    ],
  },
  receipt: {
    schemaType: 'receipt',
    version: 1,
    subject: 'a receipt for a purchase already paid',
    keywords: ['kvitto', 'moms', 'totalt', 'betalt', 'kort', 'org', 'datum'],
    fields: [
      ...party('merchant', 'merchant'),
      { name: 'receipt_date', kind: 'date', description: 'Date of purchase, YYYY-MM-DD.', required: true },
      { name: 'receipt_number', kind: 'text', description: 'Receipt or transaction number.' },
      { name: 'total_amount', kind: 'amount', description: 'Total paid including VAT.', required: true },
      { name: 'vat_amount', kind: 'amount', description: 'VAT amount, if printed.' },
      { name: 'currency', kind: 'text', description: 'Currency, ISO code.' },
      { name: 'payment_method', kind: 'prose', description: 'How it was paid (card, Swish, cash) and card ending, if printed.' },
      { name: 'items_summary', kind: 'prose', description: 'The items bought, separated by semicolons.' },
    ],
  },
  supplier_invoice: {
    schemaType: 'supplier_invoice',
    version: 1,
    subject: 'an invoice the company must pay',
    keywords: ['faktura', 'fakturanummer', 'förfallodatum', 'att betala', 'moms', 'bankgiro', 'plusgiro', 'ocr'],
    fields: [
      ...party('supplier', 'supplier'),
      { name: 'invoice_number', kind: 'text', description: 'Invoice number.', required: true },
      { name: 'invoice_date', kind: 'date', description: 'Invoice date, YYYY-MM-DD.' },
      { name: 'due_date', kind: 'date', description: 'Due date, YYYY-MM-DD.' },
      { name: 'total_amount', kind: 'amount', description: 'Total to pay including VAT.', required: true },
      { name: 'vat_amount', kind: 'amount', description: 'VAT amount.' },
      { name: 'currency', kind: 'text', description: 'Currency, ISO code.' },
      { name: 'ocr_reference', kind: 'text', description: 'OCR or payment reference.' },
      { name: 'bankgiro', kind: 'text', description: 'Bankgiro number to pay to.' },
      { name: 'plusgiro', kind: 'text', description: 'Plusgiro number to pay to.' },
      { name: 'items_summary', kind: 'prose', description: 'What is invoiced, separated by semicolons.' },
    ],
  },
  credit_note: {
    schemaType: 'credit_note',
    version: 1,
    subject: 'a credit note that reduces an earlier invoice',
    keywords: ['kreditfaktura', 'kreditnota', 'kreditering', 'avser faktura', 'moms'],
    fields: [
      ...party('supplier', 'issuer'),
      { name: 'credit_note_number', kind: 'text', description: 'Credit note number.' },
      { name: 'invoice_reference', kind: 'text', description: 'The invoice it credits.' },
      { name: 'credit_date', kind: 'date', description: 'Date, YYYY-MM-DD.' },
      { name: 'total_amount', kind: 'amount', description: 'Credited amount including VAT.', required: true },
      { name: 'vat_amount', kind: 'amount', description: 'VAT amount.' },
      { name: 'currency', kind: 'text', description: 'Currency, ISO code.' },
    ],
  },
  customer_invoice: {
    schemaType: 'customer_invoice',
    version: 1,
    subject: "a copy of the company's own sales invoice",
    keywords: ['faktura', 'fakturanummer', 'förfallodatum', 'kund', 'moms', 'att betala'],
    fields: [
      ...party('customer', 'customer'),
      { name: 'invoice_number', kind: 'text', description: 'Invoice number.', required: true },
      { name: 'invoice_date', kind: 'date', description: 'Invoice date, YYYY-MM-DD.' },
      { name: 'due_date', kind: 'date', description: 'Due date, YYYY-MM-DD.' },
      { name: 'total_amount', kind: 'amount', description: 'Total including VAT.', required: true },
      { name: 'vat_amount', kind: 'amount', description: 'VAT amount.' },
      { name: 'currency', kind: 'text', description: 'Currency, ISO code.' },
    ],
  },
  bank_statement: {
    schemaType: 'bank_statement',
    version: 1,
    subject: 'a bank account statement',
    keywords: ['kontoutdrag', 'saldo', 'ingående', 'utgående', 'period', 'konto', 'clearing', 'iban'],
    fields: [
      { name: 'bank_name', kind: 'text', description: 'Name of the bank.' },
      { name: 'account_number', kind: 'text', description: 'Account number, IBAN or clearing plus number, as printed.' },
      { name: 'period_start', kind: 'date', description: 'First day of the statement period, YYYY-MM-DD.', required: true },
      { name: 'period_end', kind: 'date', description: 'Last day of the statement period, YYYY-MM-DD.', required: true },
      { name: 'opening_balance', kind: 'amount', description: 'Opening balance.' },
      { name: 'closing_balance', kind: 'amount', description: 'Closing balance.' },
      { name: 'currency', kind: 'text', description: 'Currency, ISO code.' },
      { name: 'transaction_count', kind: 'int', description: 'Number of transactions listed.' },
    ],
  },
  tax_account_statement: {
    schemaType: 'tax_account_statement',
    version: 1,
    subject: 'a skattekonto statement from Skatteverket',
    keywords: ['skattekonto', 'kontoutdrag', 'saldo', 'ingående', 'utgående', 'inbetalning', 'debitering'],
    fields: [
      { name: 'org_number', kind: 'orgnr', description: 'Organisationsnummer the account belongs to.' },
      { name: 'period_start', kind: 'date', description: 'First day of the period, YYYY-MM-DD.', required: true },
      { name: 'period_end', kind: 'date', description: 'Last day of the period, YYYY-MM-DD.', required: true },
      { name: 'opening_balance', kind: 'amount', description: 'Opening balance; negative when a debt.' },
      { name: 'closing_balance', kind: 'amount', description: 'Closing balance; negative when a debt.' },
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
      { name: 'key_terms', kind: 'prose', description: 'The three to five most important terms or facts, in one sentence each, separated by semicolons.' },
    ],
  },
}

/** The schema that reads a document of this type; the generic one when the taxonomy has no dedicated schema (doc_type other). */
export function schemaForType(docType: DocType | string | null | undefined): ExtractionSchemaDef {
  return (docType && SCHEMAS[docType]) || SCHEMAS.generic
}

/**
 * JSON schema for the forced tool call. Flat on purpose: each field is three
 * scalar properties (`name`, `name_page`, `name_quote`), because smaller
 * models mangle nested per-field objects into strings.
 */
export function jsonSchemaFor(def: ExtractionSchemaDef): Record<string, unknown> {
  const properties: Record<string, unknown> = {}
  for (const f of def.fields) {
    properties[f.name] = { ...valueSchema(f), description: f.description }
    properties[`${f.name}_page`] = { type: ['integer', 'null'], description: `The page ${f.name} was read from.` }
    properties[`${f.name}_quote`] = { type: ['string', 'null'], description: `Up to twelve words copied exactly from that page around ${f.name}.` }
  }
  return { type: 'object', additionalProperties: false, required: Object.keys(properties), properties }
}

function valueSchema(f: FieldDef): Record<string, unknown> {
  switch (f.kind) {
    case 'amount':
    case 'percent':
    case 'int':
      return { type: ['number', 'null'] }
    case 'enum':
      return { type: ['string', 'null'], enum: [...(f.options ?? []), null] }
    default:
      return { type: ['string', 'null'] }
  }
}

/** A model's answer to the flat tool schema, as one unvalidated reading per field. */
export function readingsFromAnswer(def: ExtractionSchemaDef, answer: unknown): Record<string, { value: unknown; page: unknown; quote: unknown }> {
  const flat = answer && typeof answer === 'object' && !Array.isArray(answer) ? (answer as Record<string, unknown>) : {}
  return Object.fromEntries(def.fields.map((f) => [f.name, { value: flat[f.name], page: flat[`${f.name}_page`], quote: flat[`${f.name}_quote`] }]))
}

/** The fields a page shows before folding the rest: the required ones, money, dates, organisation numbers and names. */
export function primaryFields(def: ExtractionSchemaDef): Set<string> {
  return new Set(def.fields.filter((f) => f.required || f.kind === 'amount' || f.kind === 'date' || f.kind === 'orgnr' || f.name.endsWith('_name')).map((f) => f.name))
}

export function fieldKinds(def: ExtractionSchemaDef): Record<string, FieldKind> {
  return Object.fromEntries(def.fields.map((f) => [f.name, f.kind]))
}
