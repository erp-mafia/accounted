import { roundOre } from '@/lib/money'
import { findColumn } from '../shared/column-utils'
import type { DetectedEmployeeColumns } from './types'

// Keyword lists are matched against normalised headers (lowercase, with
// _ - . / turned into spaces) by equality or substring. Order matters below:
// the more specific families (cutover columns, first/last name) are claimed
// before the generic ones ("namn", "semesterdagar") so a substring never
// steals a column that a longer header already identified.

const FIRST_NAME_KEYWORDS = ['förnamn', 'fornamn', 'first name', 'firstname', 'tilltalsnamn', 'given name']
const LAST_NAME_KEYWORDS = ['efternamn', 'last name', 'lastname', 'surname', 'family name']
const FULL_NAME_KEYWORDS = ['namn', 'name', 'anställd', 'anstalld', 'employee']

const PERSONNUMMER_KEYWORDS = [
  'personnummer', 'personnr', 'person nr', 'pnr', 'personal number', 'personal id',
  'personal identity number', 'ssn', 'födelsenummer', 'fodelsenummer',
]

const EMAIL_KEYWORDS = ['e post', 'epost', 'email', 'e mail', 'mail']
const PHONE_KEYWORDS = ['telefon', 'telefonnummer', 'mobil', 'mobile', 'phone']

const EMPLOYMENT_START_KEYWORDS = [
  'anställningsdatum', 'anstallningsdatum', 'anställd från', 'anstalld fran',
  'anställd sedan', 'anstalld sedan', 'anställningsdag', 'anstallningsdag',
  'startdatum', 'employment start', 'start date', 'hire date', 'hired',
]

const EMPLOYMENT_DEGREE_KEYWORDS = [
  'sysselsättningsgrad', 'sysselsattningsgrad', 'anställningsgrad', 'anstallningsgrad',
  'tjänstgöringsgrad', 'tjanstgoringsgrad', 'employment degree', 'fte', 'omfattning',
]

const SALARY_TYPE_KEYWORDS = ['löneform', 'loneform', 'lönetyp', 'lonetyp', 'salary type', 'pay type']

const MONTHLY_SALARY_KEYWORDS = [
  'månadslön', 'manadslon', 'monthly salary', 'lön per månad', 'lon per manad', 'grundlön', 'grundlon',
]
const HOURLY_RATE_KEYWORDS = ['timlön', 'timlon', 'hourly rate', 'hourly', 'lön per timme', 'lon per timme']

const TAX_TABLE_KEYWORDS = ['skattetabell', 'skattetab', 'tax table', 'tabell']
const TAX_COLUMN_KEYWORDS = ['skattekolumn', 'kolumn', 'tax column', 'column']
const MUNICIPALITY_KEYWORDS = [
  'folkbokföringskommun', 'folkbokforingskommun', 'skattekommun', 'kommun', 'municipality',
]

const CLEARING_KEYWORDS = ['clearingnummer', 'clearingnr', 'clearing number', 'clearing']
const BANK_ACCOUNT_KEYWORDS = ['kontonummer', 'kontonr', 'bankkonto', 'bank account', 'account number', 'konto']

const VACATION_DAYS_KEYWORDS = [
  'semesterdagar per år', 'semesterdagar per ar', 'semesterrätt', 'semesterratt',
  'semesterdagar', 'vacation days', 'holiday days', 'annual leave',
]
const HOURS_PER_WEEK_KEYWORDS = [
  'timmar per vecka', 'timmar vecka', 'veckoarbetstid', 'arbetstid per vecka',
  'hours per week', 'weekly hours',
]

// Cutover (ingående saldon) columns.
const YTD_GROSS_KEYWORDS = [
  'ingående bruttolön', 'ingaende bruttolon', 'ackumulerad bruttolön', 'ackumulerad bruttolon',
  'ack bruttolön', 'ack bruttolon', 'bruttolön hittills', 'bruttolon hittills', 'ytd gross', 'gross ytd',
]
const YTD_TAX_KEYWORDS = [
  'ingående skatt', 'ingaende skatt', 'ackumulerad skatt', 'ack skatt', 'skatt hittills',
  'ingående preliminärskatt', 'ytd tax', 'tax ytd',
]
const YTD_NET_KEYWORDS = [
  'ingående nettolön', 'ingaende nettolon', 'ackumulerad nettolön', 'ackumulerad nettolon',
  'ack nettolön', 'ack nettolon', 'nettolön hittills', 'ytd net', 'net ytd',
]
const VACATION_REMAINING_KEYWORDS = [
  'kvarvarande betalda semesterdagar', 'kvarvarande semesterdagar', 'betalda semesterdagar kvar',
  'semesterdagar kvar', 'kvar semester', 'remaining vacation days', 'vacation days remaining',
  'vacation remaining',
]
const CUTOVER_DATE_KEYWORDS = [
  'brytdatum', 'övergångsdatum', 'overgangsdatum', 'cutover date', 'cutover', 'ingående datum',
]

/**
 * Detect employee-register columns from headers. Header-only matching, like
 * the customer and supplier detectors: register exports always carry headers.
 */
export function detectEmployeeColumns(headers: string[]): DetectedEmployeeColumns {
  const taken = new Set<number>()

  // Specific families first so their substrings cannot be stolen by the
  // generic keywords further down.
  const ytd_gross_col = findColumn(headers, YTD_GROSS_KEYWORDS, taken)
  const ytd_tax_col = findColumn(headers, YTD_TAX_KEYWORDS, taken)
  const ytd_net_col = findColumn(headers, YTD_NET_KEYWORDS, taken)
  const vacation_paid_days_remaining_col = findColumn(headers, VACATION_REMAINING_KEYWORDS, taken)
  const cutover_date_col = findColumn(headers, CUTOVER_DATE_KEYWORDS, taken)

  const first_name_col = findColumn(headers, FIRST_NAME_KEYWORDS, taken)
  const last_name_col = findColumn(headers, LAST_NAME_KEYWORDS, taken)
  const personnummer_col = findColumn(headers, PERSONNUMMER_KEYWORDS, taken)
  const employment_start_col = findColumn(headers, EMPLOYMENT_START_KEYWORDS, taken)
  const employment_degree_col = findColumn(headers, EMPLOYMENT_DEGREE_KEYWORDS, taken)
  const salary_type_col = findColumn(headers, SALARY_TYPE_KEYWORDS, taken)
  const monthly_salary_col = findColumn(headers, MONTHLY_SALARY_KEYWORDS, taken)
  const hourly_rate_col = findColumn(headers, HOURLY_RATE_KEYWORDS, taken)
  const tax_table_col = findColumn(headers, TAX_TABLE_KEYWORDS, taken)
  const tax_column_col = findColumn(headers, TAX_COLUMN_KEYWORDS, taken)
  const municipality_col = findColumn(headers, MUNICIPALITY_KEYWORDS, taken)
  const clearing_number_col = findColumn(headers, CLEARING_KEYWORDS, taken)
  const bank_account_col = findColumn(headers, BANK_ACCOUNT_KEYWORDS, taken)
  const hours_per_week_col = findColumn(headers, HOURS_PER_WEEK_KEYWORDS, taken)
  const vacation_days_col = findColumn(headers, VACATION_DAYS_KEYWORDS, taken)
  const email_col = findColumn(headers, EMAIL_KEYWORDS, taken)
  const phone_col = findColumn(headers, PHONE_KEYWORDS, taken)

  // The combined name column only matters when neither half was found.
  const full_name_col =
    first_name_col === null && last_name_col === null
      ? findColumn(headers, FULL_NAME_KEYWORDS, taken)
      : null

  const hasName = (first_name_col !== null && last_name_col !== null) || full_name_col !== null

  // Confidence: personnummer + a name are required; bonus from how many of
  // the payroll-shaping columns matched.
  let confidence = 0
  if (personnummer_col !== null && hasName) {
    const matched = [
      employment_start_col,
      monthly_salary_col ?? hourly_rate_col,
      tax_table_col ?? municipality_col,
      email_col,
      clearing_number_col ?? bank_account_col,
      employment_degree_col,
    ].filter((c) => c !== null && c !== undefined).length
    confidence = 0.55 + Math.min(matched, 6) * 0.075
  }

  return {
    first_name_col,
    last_name_col,
    full_name_col,
    personnummer_col,
    email_col,
    phone_col,
    employment_start_col,
    employment_degree_col,
    salary_type_col,
    monthly_salary_col,
    hourly_rate_col,
    tax_table_col,
    tax_column_col,
    municipality_col,
    clearing_number_col,
    bank_account_col,
    vacation_days_col,
    hours_per_week_col,
    ytd_gross_col,
    ytd_tax_col,
    ytd_net_col,
    vacation_paid_days_remaining_col,
    cutover_date_col,
    confidence: Math.min(roundOre(confidence), 1),
  }
}
