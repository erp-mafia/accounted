/**
 * Fora's monthly file: uppmärkning and pay for one company and one payment
 * month, as Fora's "Filspecifikation för uppmärkning av anställda och
 * månatlig lönerapportering" v1.37 (section 4) and its appendix v2.0 lay it
 * out. The employer uploads it on Fora's Mina sidor.
 *
 * Pure: the caller (./monthly-report.ts) reads the books and decrypts the
 * personnummer; this decides who is in the month and shapes the JSON.
 *
 * Re-sending is safe, which is why nothing remembers what was sent. A
 * payroll row replaces what Fora holds for that payMonth, and a markup with
 * a start date replaces Fora's markups from that date on (appendix 2.4, 3.3),
 * so the file always carries the employee's current code and the month's
 * full pay, and a correction is the regenerated file.
 *
 * Who is in the month: every employee with a code whose code applies by the
 * month's last day and who was either employed during the month or paid in
 * it (a final salary after the last day, appendix 3.7). An employee with an
 * active code and no payout is reported with payAmount 0: Fora asks for every
 * marked-up worker every month (appendix 3.1).
 */
import { roundToWholeKronor } from '@/lib/money'
import { orgNumberKey } from '@/lib/invariants/org-number'

/** Fora's `source` (max 40): the system the file comes from. */
export const FORA_FILE_SOURCE = 'Accounted'

const NAME_MAX = 40
const STREET_MAX = 60
const CITY_MAX = 40

export interface ForaFileAddress {
  streetAddress: string
  postalCode: string
  city: string
  countryCode: 'SE'
}

export interface ForaEmployment {
  employeeId: string
  firstName: string
  lastName: string
  address?: ForaFileAddress
  employmentEndDate: string | null
  markups: Array<{ fokId: string; startDate: string }>
}

export interface ForaPayroll {
  employeeId: string
  firstName: string
  lastName: string
  payMonth: string
  payAmount: number
}

export interface ForaReport {
  refId: string
  organizationNumber: string
  employments: ForaEmployment[]
  payrolls: ForaPayroll[]
}

export interface ForaFile {
  source: string
  reports: ForaReport[]
}

/** One employee with a Fora code, as the month sees them. */
export interface ForaEmployeeInput {
  /** employees.id: names the employee in warnings and the summary. */
  id: string
  /** 12 digits, decrypted. */
  personnummer: string
  firstName: string
  lastName: string
  addressLine1: string | null
  postalCode: string | null
  city: string | null
  fokId: string
  /** YYYY-MM-DD */
  fokStartDate: string
  /** YYYY-MM-DD */
  employmentStart: string
  /** YYYY-MM-DD or null */
  employmentEnd: string | null
  /** Fora pay paid out in the month, SEK with öre; null when nothing was paid. */
  pay: number | null
}

export type ForaWarningCode =
  | 'FORA_PAID_BEFORE_CODE_START'
  | 'FORA_NEGATIVE_PAY'
  | 'FORA_RUN_NOT_APPROVED'
  | 'FORA_ARBETARE_WITHOUT_CODE'

/**
 * Something the user should know before uploading; the file is still made.
 * `message` is the Swedish sentence; the fields beside it let a client word
 * it in its own language.
 */
export interface ForaWarning {
  code: ForaWarningCode
  message: string
  employee_id?: string
  employee_name?: string
  /** FORA_PAID_BEFORE_CODE_START: the date the code applies from. */
  fok_start_date?: string
  /** FORA_NEGATIVE_PAY: the month's pay in whole kronor, below zero. */
  pay_amount?: number
  /** FORA_RUN_NOT_APPROVED: the run, its period (YYYY-MM) and payment date. */
  salary_run_id?: string
  run_period?: string
  payment_date?: string
}

export type ForaIssueCode =
  | 'FORA_ORG_NUMBER_MISSING'
  | 'FORA_ADDRESS_REQUIRED'
  | 'FORA_NO_CODED_EMPLOYEES'
  | 'FORA_NOTHING_IN_MONTH'

/** Something that blocks the file. */
export interface ForaIssue {
  code: ForaIssueCode
  message: string
  employee_id?: string
  employee_name?: string
}

/** What the month reports per employee, for the summary the user checks. */
export interface ForaPayrollSummary {
  employee_id: string
  employee_name: string
  fok_id: string
  pay_amount: number
  employment_end: string | null
}

export type BuildForaFileResult =
  | { ok: true; file: ForaFile; payrolls: ForaPayrollSummary[]; warnings: ForaWarning[] }
  | { ok: false; issues: ForaIssue[] }

export interface BuildForaFileInput {
  orgNumber: string
  year: number
  month: number
  employees: readonly ForaEmployeeInput[]
}

/** "YYYY-MM-DD" to Fora's "YYYYMMDD". */
function compactDate(iso: string): string {
  return iso.slice(0, 10).replace(/-/g, '')
}

function monthBounds(year: number, month: number): { first: string; last: string } {
  const mm = String(month).padStart(2, '0')
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate()
  return { first: `${year}-${mm}-01`, last: `${year}-${mm}-${String(lastDay).padStart(2, '0')}` }
}

/** Samordningsnummer carry the birth day plus 60 (61-91). */
export function isSamordningsnummer(personnummer: string): boolean {
  const day = Number(personnummer.slice(6, 8))
  return day >= 61 && day <= 91
}

function fullName(e: ForaEmployeeInput): string {
  return `${e.firstName} ${e.lastName}`.trim()
}

function clip(value: string, max: number): string {
  return value.trim().slice(0, max)
}

export function buildForaFile(input: BuildForaFileInput): BuildForaFileResult {
  const issues: ForaIssue[] = []
  const warnings: ForaWarning[] = []
  const organizationNumber = orgNumberKey(input.orgNumber)
  if (!organizationNumber) {
    issues.push({
      code: 'FORA_ORG_NUMBER_MISSING',
      message: 'Företaget saknar organisationsnummer. Lägg in det under Inställningar > Företag.',
    })
  }

  const { first, last } = monthBounds(input.year, input.month)
  const payMonth = `${input.year}${String(input.month).padStart(2, '0')}`

  const employments: ForaEmployment[] = []
  const payrolls: ForaPayroll[] = []
  const summary: ForaPayrollSummary[] = []

  const sorted = [...input.employees].sort(
    (a, b) => a.lastName.localeCompare(b.lastName, 'sv') || a.firstName.localeCompare(b.firstName, 'sv'),
  )

  for (const e of sorted) {
    const name = fullName(e)
    const codeActive = e.fokStartDate <= last
    const employedInMonth = e.employmentStart <= last && (e.employmentEnd === null || e.employmentEnd >= first)
    const paid = e.pay !== null

    if (!codeActive) {
      if (paid) {
        warnings.push({
          code: 'FORA_PAID_BEFORE_CODE_START',
          employee_id: e.id,
          employee_name: name,
          fok_start_date: e.fokStartDate,
          message: `${name} fick lön i månaden, men Fora-koden gäller först från ${e.fokStartDate}. Lönen är inte med i filen.`,
        })
      }
      continue
    }
    if (!employedInMonth && !paid) continue

    let address: ForaFileAddress | undefined
    // Fora needs an address only for samordningsnummer (spec 4.1, footnote 3).
    if (isSamordningsnummer(e.personnummer)) {
      const street = e.addressLine1?.trim() ?? ''
      const postalCode = (e.postalCode ?? '').replace(/\s/g, '')
      const city = e.city?.trim() ?? ''
      if (!street || !/^\d{5}$/.test(postalCode) || !city) {
        issues.push({
          code: 'FORA_ADDRESS_REQUIRED',
          employee_id: e.id,
          employee_name: name,
          message: `${name} har samordningsnummer, och då kräver Fora en adress. Fyll i gatuadress, postnummer (fem siffror) och ort på den anställda.`,
        })
        continue
      }
      address = { streetAddress: clip(street, STREET_MAX), postalCode, city: clip(city, CITY_MAX), countryCode: 'SE' }
    }

    let payAmount = roundToWholeKronor(e.pay ?? 0)
    if (payAmount < 0) {
      warnings.push({
        code: 'FORA_NEGATIVE_PAY',
        employee_id: e.id,
        employee_name: name,
        pay_amount: payAmount,
        message: `${name} har negativ bruttolön i månaden (${payAmount} kr), troligen en rättelse. Filen anger 0 kr: rätta i stället den månad som var fel, på Foras Mina sidor eller med en ny fil för den månaden.`,
      })
      payAmount = 0
    }

    const firstName = clip(e.firstName, NAME_MAX)
    const lastName = clip(e.lastName, NAME_MAX)
    employments.push({
      employeeId: e.personnummer,
      firstName,
      lastName,
      ...(address ? { address } : {}),
      employmentEndDate: e.employmentEnd ? compactDate(e.employmentEnd) : null,
      markups: [{ fokId: e.fokId, startDate: compactDate(e.fokStartDate) }],
    })
    payrolls.push({ employeeId: e.personnummer, firstName, lastName, payMonth, payAmount })
    summary.push({
      employee_id: e.id,
      employee_name: name,
      fok_id: e.fokId,
      pay_amount: payAmount,
      employment_end: e.employmentEnd,
    })
  }

  if (issues.length === 0 && payrolls.length === 0) {
    issues.push(
      input.employees.length === 0
        ? {
            code: 'FORA_NO_CODED_EMPLOYEES',
            message:
              'Ingen anställd har en Fora-kod. Lägg in koden (FOK följt av sex siffror, finns på Foras Mina sidor) på de anställda som ska rapporteras till Fora.',
          }
        : {
            code: 'FORA_NOTHING_IN_MONTH',
            message: 'Ingen anställd med Fora-kod var anställd eller fick lön den här månaden.',
          },
    )
  }
  if (issues.length > 0) return { ok: false, issues }

  return {
    ok: true,
    file: {
      source: FORA_FILE_SOURCE,
      reports: [{ refId: payMonth, organizationNumber: organizationNumber!, employments, payrolls }],
    },
    payrolls: summary,
    warnings,
  }
}
