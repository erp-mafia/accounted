/**
 * Build the salary payment file for a run: ISO 20022 pain.001 XML or the
 * legacy Bankgirot LB text file.
 *
 * Single source of truth for the loading, the preconditions and the
 * `payment_file_format` / `payment_file_generated_at` stamp shared by the
 * dashboard routes (app/api/salary/runs/[id]/payment/{pain001,bg-lb}), the
 * public endpoint (POST /api/v1/companies/:companyId/salary-runs/:id/payment-file)
 * and the MCP operation (lib/operations/salary-payment-files.ts). The doors
 * only translate the result: the dashboard keeps its legacy `{ error: string }`
 * envelope and download headers, v1 and MCP map codes onto the
 * structured-error catalogue through salaryPaymentFileRefusal().
 *
 * Preconditions, in the order they are checked (and the order the queries run,
 * which the dashboard route tests depend on):
 *
 *   1. run exists for the company
 *   2. run status is approved, paid or booked
 *   3. company row exists
 *   4. company_settings row (pain.001) / bankgiro (LB) present and valid
 *   5. company IBAN present and BIC present or derivable (pain.001), and
 *      for a Swedbank debtor Swedbank's SignerID and Corporate Pay id
 *   6. the run has employees
 *   7. every employee with a positive payout has clearing + account
 *   8. every one of those accounts names a payable account
 *      (payeeAccountProblem, the same verdict the generators apply): all
 *      affected employees are named at once, never the account number
 *   9. on a live call, no bank payment of the run is live: the archive
 *      refuses the file (IN_BANK_PAYMENT), since the file and the bank
 *      payments would each pay the month (lib/salary/payment/pay-via-bank.ts)
 *
 * Employees whose effective net payout is 0 (nollkörning, net fully consumed
 * by a nettolöneavdrag) are left out of the file, so their bank details are
 * not required (see lib/salary/payment/effective-net.ts).
 *
 * Every amount is the run's payable amount (lib/salary/payment/payable.ts),
 * the same rule the bank payments follow: the effective net for an ordinary
 * run, and for a correction run (rättelsekörning) only the difference
 * against what the corrected run already paid. The chain a correction
 * replaces is read after the run's employees, so an ordinary run makes
 * exactly the queries it made before. An employee a correction overpaid is
 * left out of the file and named (`correction.overpaid` and a warning); a
 * correction with no positive difference has no file (NOTHING_TO_PAY).
 *
 * Versions (crm#1219). A pain.001 carries the run's payment file version in
 * its ids (salaryPaymentMessageId). Every download returns the run's current
 * version, so a re-download is the same message to the bank and its duplicate
 * check refuses a second upload of the month. A new version (newVersion) gets
 * new ids so the bank takes a corrected file; it is refused unless the person
 * confirms the earlier file was not approved at the bank, and the archive
 * trigger (20261015230000) raises the run only with that confirmation.
 *
 * Per BFL 7 kap. 1 § the generated file is räkenskapsinformation (underlag)
 * linked to the salary journal entry and subject to 7-year retention, so on a
 * live call the exact file is archived as a `salary_payment_files` row (WORM)
 * before it is handed out: an archive failure is a hard error, the run stamp
 * that follows is not. The archived sha256 / byte_size are over the bytes the
 * HTTP layer sends (UTF-8 for pain.001, ISO 8859-1 for LB), so a bank-side
 * copy can be verified against the archive.
 */

import { createHash, randomUUID } from 'crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getErrorMessage } from '@/lib/errors/get-error-message'
import { getBranding } from '@/lib/branding/service'
import { formatCurrency } from '@/lib/utils'
import { validateBankgiroNumber } from '@/lib/bankgiro/luhn'
import { generatePain001, pain001TransactionId } from './pain001-generator'
import type { Pain001CompanyData, Pain001Employee } from './pain001-generator'
import { generateBgLb, utbetalningsnummer } from './bg-lb-generator'
import type { BgLbCompanyData, BgLbEmployee } from './bg-lb-generator'
import {
  CORRECTION_DIFFERENCE_ONLY_SV,
  loadCorrectionPaidBefore,
  overpaidEmployees,
  overpaidSentenceSv,
  payableAmount,
  type OverpaidEmployee,
} from './payable'
import { isSalaryInBankPaymentError } from './in-bank-payment'
import { resolveSwedbankFileIds } from '@/lib/payments/swedbank'
import {
  checkEmployeeAccountChecksum,
  describePayeeAccountProblems,
  lookupBicByBankName,
  lookupBicByClearing,
  maskPayeeAccount,
  normalizeBankNumber,
  payeeAccountProblem,
} from '@/lib/payments/bank-account'

import { SALARY_PAYMENT_FILE_FORMATS, type SalaryPaymentFileFormat } from './payment-format'

export { SALARY_PAYMENT_FILE_FORMATS, type SalaryPaymentFileFormat }

/** Run statuses a payment file may be generated from. */
export const SALARY_PAYMENT_FILE_ALLOWED_STATUSES = ['approved', 'paid', 'booked'] as const

export interface BuildSalaryPaymentFileInput {
  companyId: string
  runId: string
  /** The user generating the file; recorded on the archived row (who/when). */
  userId: string
  /** Omit to use company_settings.preferred_payment_format (default pain001). */
  format?: SalaryPaymentFileFormat
  /**
   * Validate every precondition and compute the preview (the pure generator
   * still runs so a preview that passes means the real call passes) but never
   * stamp the run.
   */
  dryRun?: boolean
  /**
   * Make the next version of the run's pain.001: new MsgId, PmtInfId and
   * EndToEndIds, so the bank takes the file although an earlier one for the
   * run reached it. pain.001 only.
   */
  newVersion?: boolean
  /**
   * The person's confirmation that the earlier file was NOT approved at the
   * bank. Required with newVersion: two approved files pay the month twice,
   * and the bank's duplicate check no longer stops a new version.
   */
  confirmPreviousNotApproved?: boolean
}

export type SalaryPaymentFileErrorCode =
  | 'RUN_NOT_FOUND'
  | 'RUN_NOT_READY'
  | 'COMPANY_NOT_FOUND'
  | 'SETTINGS_MISSING'
  | 'IBAN_MISSING'
  | 'BIC_MISSING'
  | 'SWEDBANK_IDS_MISSING'
  | 'BANKGIRO_MISSING'
  | 'BANKGIRO_INVALID'
  | 'NO_EMPLOYEES'
  | 'EMPLOYEE_BANK_MISSING'
  | 'EMPLOYEE_BANK_INVALID'
  | 'GENERATOR_FAILED'
  | 'ARCHIVE_FAILED'
  | 'DB_ERROR'
  | 'NEW_VERSION_UNCONFIRMED'
  | 'NEW_VERSION_UNSUPPORTED'
  | 'IN_BANK_PAYMENT'
  | 'NOTHING_TO_PAY'

export type SalaryPaymentFileLoadStage = 'run' | 'company' | 'settings' | 'employees' | 'correction'

/**
 * One payment the file carries, in file order: the banklista line. Built from
 * the same payee array the generator wrote, so the list and the file cannot
 * disagree.
 */
export interface SalaryPaymentFilePayee {
  employeeId: string
  name: string
  /** Clearing number and the last four digits of the account (maskPayeeAccount). */
  maskedAccount: string
  /** The amount in the file, rounded to öre. */
  amount: number
  /**
   * What ties the line to its record in the file: the EndToEndId (pain.001)
   * or the utbetalningsnummer on the TK40/TK14 pair (Bankgirot LB).
   */
  reference: string
}

/** The payer as the file names it. */
export interface SalaryPaymentFilePayer {
  name: string
  orgNumber: string | null
  /** The debtor IBAN (pain.001) or the sender bankgiro (LB), as written in the file. */
  account: string
}

export interface SalaryPaymentFileError {
  ok: false
  code: SalaryPaymentFileErrorCode
  /** The resolved format, or null when the failure happened before it was known. */
  format: SalaryPaymentFileFormat | null
  /** The query that failed (DB_ERROR only). */
  stage?: SalaryPaymentFileLoadStage
  /** Machine-readable context for the caller's envelope. */
  details: Record<string, unknown>
  /** The underlying error (DB_ERROR, ARCHIVE_FAILED and GENERATOR_FAILED). */
  cause?: unknown
}

export interface SalaryPaymentFileOk {
  ok: true
  format: SalaryPaymentFileFormat
  filename: string
  /** The file as a JS string. LB content is Latin-1 safe; the HTTP layer re-encodes. */
  content: string
  contentType: 'application/xml' | 'text/plain'
  charset: 'utf-8' | 'iso-8859-1'
  /**
   * Lowercase hex SHA-256 over the file bytes as the HTTP layer sends them:
   * `content` encoded as UTF-8 for pain001 and as ISO 8859-1 for bg_lb.
   */
  sha256: string
  /** Size in bytes of the file in that same encoding. */
  byteSize: number
  paymentDate: string
  periodLabel: string
  /** Employees that appear in the file (positive payout). */
  employeeCount: number
  /** Sum of `payees[].amount`: the file's control sum (pain.001 CtrlSum, LB TK29). */
  totalAmount: number
  /** The payments the file carries, in file order (the banklista). */
  payees: SalaryPaymentFilePayee[]
  payer: SalaryPaymentFilePayer
  /** Non-blocking Swedish annotations the caller should surface. */
  warnings: string[]
  /** Value written to payment_file_generated_at; null on a dry run. */
  generatedAt: string | null
  /** False when the stamp UPDATE failed or was skipped (dry run). The file is still returned. */
  stamped: boolean
  /** Id of the archived salary_payment_files row; null on a dry run (nothing is archived). */
  paymentFileId: string | null
  /** The payment file version the file carries (1 for Bankgirot LB). */
  version: number
  /**
   * Set for a correction run (rättelsekörning): every amount is the
   * difference against what the corrected run already paid, and an employee
   * it overpaid is left out and named with the amount. Null for an ordinary run.
   */
  correction: SalaryPaymentFileCorrection | null
}

/** A correction run's file: what it corrects and whom it overpaid. */
export interface SalaryPaymentFileCorrection {
  correctsRunId: string
  overpaid: OverpaidEmployee[]
}

export type SalaryPaymentFileResult = SalaryPaymentFileOk | SalaryPaymentFileError

interface RunRow {
  id: string
  status: string
  period_year: number
  period_month: number
  payment_date: string
  /** The run's pain.001 version (20261015230000); absent before the column existed. */
  payment_file_version?: number | null
  /** The run a correction run corrects (salary_runs.corrects_run_id); null for an ordinary run. */
  corrects_run_id?: string | null
}

interface SettingsRow {
  company_name: string | null
  iban: string | null
  bic: string | null
  clearing_number: string | null
  bank_name: string | null
  bankgiro: string | null
  preferred_payment_format: string | null
  city: string | null
  swedbank_signer_id: string | null
  swedbank_corporate_pay_id: string | null
}

interface RunEmployeeRow {
  employee_id: string
  net_salary: number
  tax_withheld: number
  tax_withheld_override?: number | null
  employee: {
    first_name: string
    last_name: string
    clearing_number: string | null
    bank_account_number: string | null
    /** AGI specification number: the base of the LB utbetalningsnummer. */
    specification_number: number | null
    /** Town for Cdtr/PstlAdr in Swedbank's pain.001 form. */
    city: string | null
  } | null
}

function fail(
  code: SalaryPaymentFileErrorCode,
  format: SalaryPaymentFileFormat | null,
  details: Record<string, unknown> = {},
  extra: { stage?: SalaryPaymentFileLoadStage; cause?: unknown } = {},
): SalaryPaymentFileError {
  return { ok: false, code, format, details, ...extra }
}

/**
 * Why a Swedbank debtor's pain.001 cannot be made, in Swedish: Swedbank
 * identifies the sender and the agreement by ids it assigns, and refuses a
 * file without them at upload ("Aktivt id för fullmaktshavare saknas").
 */
export const SWEDBANK_IDS_MISSING_SV =
  'Swedbank kräver företagets SignerID och avtals-id (Corporate Pay) i betalfilen. Du får dem av Swedbank. Fyll i dem under Inställningar → Fakturering.'

/** A builder refusal in the structured-errors catalogue (lib/errors/structured-errors.ts). */
export interface SalaryPaymentFileRefusal {
  code: string
  /** What the caller's envelope carries beside the code. */
  details?: Record<string, unknown>
  /** The builder's own explanation, for the log line. */
  reason?: string
}

/**
 * The structured-errors code (and details) for a builder failure, shared by
 * the v1 route and the MCP operation so both doors answer the same code for
 * the same state. Null for DB_ERROR and ARCHIVE_FAILED: those carry the
 * database error in `cause`, whose SQLSTATE decides the answer (a statement
 * timeout is transient, a constraint is not).
 */
export function salaryPaymentFileRefusal(result: SalaryPaymentFileError): SalaryPaymentFileRefusal | null {
  switch (result.code) {
    case 'RUN_NOT_FOUND':
      return { code: 'SALARY_RUN_NOT_FOUND' }
    case 'RUN_NOT_READY':
      return { code: 'SALARY_RUN_PAYMENT_FILE_NOT_READY', details: result.details }
    case 'COMPANY_NOT_FOUND':
      return { code: 'COMPANY_NOT_FOUND' }
    case 'SETTINGS_MISSING':
    case 'IBAN_MISSING':
    case 'BIC_MISSING':
    case 'SWEDBANK_IDS_MISSING':
    case 'BANKGIRO_MISSING':
    case 'BANKGIRO_INVALID':
      return {
        code: 'SALARY_RUN_PAYMENT_FILE_MISSING_BANK_DETAILS',
        reason: result.code,
        details: { format: result.format, problem: result.code.toLowerCase(), ...result.details },
      }
    case 'NO_EMPLOYEES':
      return { code: 'SALARY_RUN_NO_EMPLOYEES' }
    case 'EMPLOYEE_BANK_MISSING':
      return {
        code: 'SALARY_RUN_PAYMENT_FILE_EMPLOYEE_BANK_MISSING',
        details: { format: result.format, ...result.details },
      }
    case 'EMPLOYEE_BANK_INVALID':
      return {
        code: 'SALARY_RUN_PAYMENT_FILE_EMPLOYEE_BANK_INVALID',
        reason: String(result.details.message ?? ''),
        details: { format: result.format, ...result.details },
      }
    case 'GENERATOR_FAILED':
      return {
        code: 'SALARY_RUN_PAYMENT_FILE_GENERATION_FAILED',
        reason: String(result.details.message ?? ''),
        details: { format: result.format, ...result.details },
      }
    case 'NEW_VERSION_UNCONFIRMED':
      return { code: 'SALARY_RUN_PAYMENT_FILE_NEW_VERSION_UNCONFIRMED' }
    case 'NEW_VERSION_UNSUPPORTED':
      return { code: 'SALARY_RUN_PAYMENT_FILE_NEW_VERSION_UNSUPPORTED', details: { format: result.format } }
    case 'IN_BANK_PAYMENT':
      return { code: 'SALARY_RUN_IN_BANK_PAYMENT', details: { format: result.format } }
    case 'NOTHING_TO_PAY':
      return { code: 'SALARY_RUN_PAYMENT_FILE_NOTHING_TO_PAY', details: { format: result.format, ...result.details } }
    case 'ARCHIVE_FAILED':
    case 'DB_ERROR':
      return null
  }
}

/** The bank-list line for one payee the generator wrote. */
function payeeLine(
  e: { employeeId: string; name: string; clearingNumber: string; bankAccountNumber: string; netSalary: number },
  reference: string,
): SalaryPaymentFilePayee {
  return {
    employeeId: e.employeeId,
    name: e.name,
    maskedAccount: maskPayeeAccount(e.clearingNumber, e.bankAccountNumber),
    amount: e.netSalary,
    reference,
  }
}

/**
 * The pain.001 MsgId of a run's payment file at a version. Version 1 is the
 * id every salary file has carried, `<BRAND>-<org>-<period>`, unchanged so a
 * re-download stays the same message to the bank. A later version is
 * `LON-<org>-<period>-V<n>`: 25 characters for V2-V9, so PmtInfId and every
 * InstrId/EndToEndId keep the period and the version after the generator's
 * -PMT and -TX0001 suffixes (Max35Text). Danske Bank refuses a repeated MsgId
 * and a repeated EndToEndId for at least three months (MIG v3.6, 1.1 and
 * 2.30); Swedbank an EndToEndId within 90 days. A new version repeats neither.
 */
export function salaryPaymentMessageId(brand: string, org: string, periodLabel: string, version: number): string {
  if (version <= 1) return `${brand}-${org}-${periodLabel}`
  return `LON-${org}-${periodLabel}-V${version}`
}

function resolveFormat(
  requested: SalaryPaymentFileFormat | undefined,
  settings: SettingsRow | null,
): SalaryPaymentFileFormat {
  if (requested) return requested
  const preferred = settings?.preferred_payment_format
  return preferred === 'bg_lb' ? 'bg_lb' : 'pain001'
}

export async function buildSalaryPaymentFile(
  supabase: SupabaseClient,
  input: BuildSalaryPaymentFileInput,
): Promise<SalaryPaymentFileResult> {
  const { companyId, runId } = input
  const requestedFormat = input.format ?? null

  // A new version without the confirmation is refused before anything is
  // read: it is the guard against paying the month twice.
  if (input.newVersion && input.confirmPreviousNotApproved !== true) {
    return fail('NEW_VERSION_UNCONFIRMED', requestedFormat)
  }

  // 1 + 2. The run and its status gate.
  const { data: run, error: runErr } = await supabase
    .from('salary_runs')
    .select('*')
    .eq('id', runId)
    .eq('company_id', companyId)
    .maybeSingle()
  if (runErr) return fail('DB_ERROR', requestedFormat, {}, { stage: 'run', cause: runErr })
  if (!run) return fail('RUN_NOT_FOUND', requestedFormat)

  const runRow = run as RunRow
  if (!(SALARY_PAYMENT_FILE_ALLOWED_STATUSES as readonly string[]).includes(runRow.status)) {
    return fail('RUN_NOT_READY', requestedFormat, {
      current_status: runRow.status,
      allowed_statuses: [...SALARY_PAYMENT_FILE_ALLOWED_STATUSES],
    })
  }

  // 3. Company (name fallback + org number for the pain.001 debtor id).
  const { data: company, error: companyErr } = await supabase
    .from('companies')
    .select('name, org_number')
    .eq('id', companyId)
    .maybeSingle()
  if (companyErr) return fail('DB_ERROR', requestedFormat, {}, { stage: 'company', cause: companyErr })

  // 4. Settings: the sender's bank details live here, not on companies.
  const { data: settingsData, error: settingsErr } = await supabase
    .from('company_settings')
    .select('company_name, iban, bic, clearing_number, bank_name, bankgiro, preferred_payment_format, city, swedbank_signer_id, swedbank_corporate_pay_id')
    .eq('company_id', companyId)
    .maybeSingle()
  if (settingsErr) return fail('DB_ERROR', requestedFormat, {}, { stage: 'settings', cause: settingsErr })

  if (!company) return fail('COMPANY_NOT_FOUND', requestedFormat)

  const settings = (settingsData as SettingsRow | null) ?? null
  const format = resolveFormat(input.format, settings)
  // Bankgirot LB has no message id the bank deduplicates on: no versions.
  if (input.newVersion && format !== 'pain001') return fail('NEW_VERSION_UNSUPPORTED', format)
  const companyRow = company as { name: string; org_number: string | null }
  const warnings: string[] = []

  let pain001Company: Pain001CompanyData | null = null
  let bgLbCompany: BgLbCompanyData | null = null

  if (format === 'pain001') {
    if (!settings) return fail('SETTINGS_MISSING', format)

    // Debtor account: the company's own IBAN, the canonical payer form every
    // Swedish bank accepts. Set under Inställningar → Fakturering.
    const senderIban = (settings.iban ?? '').replace(/\s/g, '').toUpperCase()
    if (!senderIban) return fail('IBAN_MISSING', format, { field: 'iban' })

    // Debtor bank BIC: the saved BIC, otherwise derived from the clearing
    // number (or bank name) the company already entered, so most users only
    // need to fill in the IBAN. Required by the receiving bank.
    const savedBic = settings.bic?.trim() || null
    const senderBic =
      savedBic ||
      lookupBicByClearing(normalizeBankNumber(settings.clearing_number)) ||
      lookupBicByBankName(settings.bank_name)
    if (!senderBic) return fail('BIC_MISSING', format, { field: 'bic' })
    if (!savedBic) {
      warnings.push(
        `BIC (${senderBic}) härleddes från företagets clearingnummer eller banknamn. Spara BIC under Inställningar → Fakturering om banken avvisar filen.`,
      )
    }

    // Swedbank (savings banks included) identifies the sender and the
    // agreement by its own SignerID and Corporate Pay id, never the org
    // number, and refuses a file without them (lib/payments/swedbank.ts).
    const swedbank = resolveSwedbankFileIds(senderBic, settings)
    if (!swedbank.ok) {
      return fail('SWEDBANK_IDS_MISSING', format, {
        fields: (['swedbank_signer_id', 'swedbank_corporate_pay_id'] as const).filter(
          (field) => !settings[field]?.trim(),
        ),
        message: SWEDBANK_IDS_MISSING_SV,
      })
    }

    pain001Company = {
      // Sender name follows the current company name (company_settings.company_name),
      // not the frozen onboarding companies.name.
      name: settings.company_name || companyRow.name,
      orgNumber: companyRow.org_number || '',
      iban: senderIban,
      bic: senderBic,
      city: settings.city,
      swedbank: swedbank.ids,
    }
  } else {
    // The settings overview shows a bankgiro from the Bolagsverket snapshot,
    // which is display data only; the file reads company_settings.bankgiro.
    if (!settings?.bankgiro) return fail('BANKGIRO_MISSING', format, { field: 'bankgiro' })
    if (!validateBankgiroNumber(settings.bankgiro)) {
      return fail('BANKGIRO_INVALID', format, { field: 'bankgiro', value: settings.bankgiro })
    }
    warnings.push(
      'Bankgirot LB-filer fasas ut av bankerna under 2026. Byt till ISO 20022 (pain.001) när banken erbjuder det.',
    )
    bgLbCompany = {
      name: settings.company_name || companyRow.name,
      senderBankgiro: settings.bankgiro,
    }
  }

  // 6. Employees on the run.
  const { data: runEmployeesData, error: employeesErr } = await supabase
    .from('salary_run_employees')
    .select('*, employee:employees(first_name, last_name, clearing_number, bank_account_number, specification_number, city)')
    .eq('salary_run_id', runId)
  if (employeesErr) return fail('DB_ERROR', format, {}, { stage: 'employees', cause: employeesErr })

  const runEmployees = (runEmployeesData as RunEmployeeRow[] | null) ?? []
  if (runEmployees.length === 0) return fail('NO_EMPLOYEES', format)

  // A correction pays only the difference against what the run it corrects
  // already paid (payable.ts). An ordinary run reads nothing more.
  const chain = await loadCorrectionPaidBefore(supabase, companyId, { id: runRow.id, corrects_run_id: runRow.corrects_run_id })
  if (!chain.ok) return fail('DB_ERROR', format, {}, { stage: 'correction', cause: chain.error })
  const paidBefore = chain.paidBefore

  // 7. Bank details, but only for employees who actually appear in the file
  // (positive payout). A zero-net employee is filtered out below, so missing
  // bank details for them must not block the file.
  // Rounded to öre here, once: this is the amount every generator writes
  // and the bank list shows, so the per-line amounts and the control sum are
  // computed from the same numbers.
  const withNet = runEmployees.map((sre) => ({
    sre,
    effectiveNet: payableAmount(sre, sre.employee_id, paidBefore),
  }))
  const paid = withNet.filter(({ effectiveNet }) => effectiveNet > 0)
  // A correction's overpaid employee is named below, not counted as a zero payout.
  const skipped = withNet.filter(({ effectiveNet }) => (paidBefore ? effectiveNet === 0 : effectiveNet <= 0)).length
  const correction: SalaryPaymentFileCorrection | null = paidBefore
    ? {
        correctsRunId: paidBefore.correctsRunId,
        overpaid: overpaidEmployees(
          runEmployees.map((sre) => ({
            ...sre,
            name: sre.employee ? `${sre.employee.first_name} ${sre.employee.last_name}`.trim() : '',
          })),
          paidBefore,
        ),
      }
    : null
  // A correction that raises nobody's net has nothing for a file to pay.
  if (correction && paid.length === 0) {
    return fail('NOTHING_TO_PAY', format, {
      correction: { corrects_run_id: correction.correctsRunId, overpaid: correction.overpaid },
    })
  }

  const missingBank = paid.filter(({ sre }) => !sre.employee?.clearing_number || !sre.employee?.bank_account_number)
  if (missingBank.length > 0) {
    return fail('EMPLOYEE_BANK_MISSING', format, {
      employee_count: missingBank.length,
      employees: missingBank.map(({ sre }) => ({
        employee_id: sre.employee_id,
        name: sre.employee ? `${sre.employee.first_name} ${sre.employee.last_name}` : null,
      })),
    })
  }

  // 8. Pairs that name no payable account. Checked for every paid employee
  // before generating, so the user gets the whole list by name in one pass
  // instead of the generator stopping at the first one. `message` is the
  // Swedish text for the HTTP layers; like `employees` it carries names and
  // problem codes, never a clearing or account number.
  const invalidBank = paid.flatMap(({ sre }) => {
    const emp = sre.employee as NonNullable<RunEmployeeRow['employee']>
    const problem = payeeAccountProblem(emp.clearing_number, emp.bank_account_number)
    if (!problem) return []
    return [{ employee_id: sre.employee_id, name: `${emp.first_name} ${emp.last_name}`, problem }]
  })
  if (invalidBank.length > 0) {
    return fail('EMPLOYEE_BANK_INVALID', format, {
      employee_count: invalidBank.length,
      employees: invalidBank,
      message: describePayeeAccountProblems(invalidBank),
    })
  }

  if (correction) {
    warnings.push(CORRECTION_DIFFERENCE_ONLY_SV)
    if (skipped > 0) {
      warnings.push(`${skipped} anställd(a) utan skillnad mot den tidigare körningen ingår inte i filen.`)
    }
    const overpaidSentence = overpaidSentenceSv(correction.overpaid, (amount) => formatCurrency(amount))
    if (overpaidSentence) warnings.push(overpaidSentence)
  } else if (skipped > 0) {
    warnings.push(
      `${skipped} anställd(a) med 0 kr i nettoutbetalning ingår inte i filen.`,
    )
  }

  const employees = paid.map(({ sre, effectiveNet }) => {
    const emp = sre.employee as NonNullable<RunEmployeeRow['employee']>
    const clearingNumber = emp.clearing_number as string
    const bankAccountNumber = emp.bank_account_number as string
    const name = `${emp.first_name} ${emp.last_name}`
    // Advisory only: the check digit catches typos, it does not prove the
    // account exists, so it never blocks the file (mirrors the employee form).
    if (checkEmployeeAccountChecksum(clearingNumber, bankAccountNumber) === 'invalid') {
      warnings.push(`${name}: kontrollsiffran i kontonumret verkar inte stämma. Dubbelkolla numret innan filen skickas.`)
    }
    // The LB file ties account to amount with an utbetalningsnummer built on
    // the employee's specification number; pain.001 ignores it.
    return {
      employeeId: sre.employee_id,
      name,
      clearingNumber,
      bankAccountNumber,
      payeeNumber: emp.specification_number ?? 0,
      netSalary: effectiveNet,
      city: emp.city ?? null,
    }
  })

  const totalAmount = Math.round(employees.reduce((sum, e) => sum + e.netSalary, 0) * 100) / 100
  const periodLabel = `${runRow.period_year}-${String(runRow.period_month).padStart(2, '0')}`
  // The run's current version, or the next one for a confirmed new version.
  const currentVersion = Math.max(1, runRow.payment_file_version ?? 1)
  const version = format === 'pain001' ? currentVersion + (input.newVersion ? 1 : 0) : 1

  // Generate. Both generators are pure; they run on a dry run too so a preview
  // that passes means the real call passes (invalid clearing, oversize field).
  let content: string
  let filename: string
  let contentType: SalaryPaymentFileOk['contentType']
  let charset: SalaryPaymentFileOk['charset']
  let payees: SalaryPaymentFilePayee[]
  try {
    if (format === 'pain001') {
      const messageId = salaryPaymentMessageId(
        getBranding().appName.toUpperCase(),
        `${companyRow.org_number?.replace('-', '')}`,
        periodLabel,
        version,
      )
      content = generatePain001(pain001Company as Pain001CompanyData, employees as Pain001Employee[], {
        messageId,
        paymentDate: runRow.payment_date,
        periodLabel,
      })
      filename = version > 1 ? `pain001_lon_${periodLabel}_v${version}.xml` : `pain001_lon_${periodLabel}.xml`
      contentType = 'application/xml'
      charset = 'utf-8'
      payees = employees.map((e, i) => payeeLine(e, pain001TransactionId(messageId, i)))
    } else {
      const result = generateBgLb(bgLbCompany as BgLbCompanyData, employees as BgLbEmployee[], {
        paymentDate: runRow.payment_date,
        periodLabel,
      })
      content = result.content
      filename = result.filename
      contentType = 'text/plain'
      charset = 'iso-8859-1'
      // The generator has already accepted every payee number, so this
      // cannot throw here; it is the number the TK40/TK14 pair carries.
      payees = employees.map((e) => payeeLine(e, utbetalningsnummer(e.payeeNumber)))
    }
  } catch (err) {
    return fail(
      'GENERATOR_FAILED',
      format,
      { message: getErrorMessage(err, { context: 'salary' }) },
      { cause: err },
    )
  }

  // Hash and size over the bytes the download sends, not over the JS string:
  // the bg-lb route re-encodes to ISO 8859-1 (Buffer.from(content, 'latin1'))
  // and pain.001 goes out as UTF-8, so the archived digest matches what the
  // bank receives.
  const bytes = Buffer.from(content, charset === 'utf-8' ? 'utf8' : 'latin1')
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const byteSize = bytes.length

  const base = {
    format,
    filename,
    content,
    contentType,
    charset,
    sha256,
    byteSize,
    paymentDate: runRow.payment_date,
    periodLabel,
    version,
    employeeCount: employees.length,
    totalAmount,
    payees,
    correction,
    payer: pain001Company
      ? { name: pain001Company.name, orgNumber: companyRow.org_number, account: pain001Company.iban }
      : {
          name: (bgLbCompany as BgLbCompanyData).name,
          orgNumber: companyRow.org_number,
          account: (bgLbCompany as BgLbCompanyData).senderBankgiro,
        },
    warnings,
  }

  if (input.dryRun) {
    return { ok: true, ...base, generatedAt: null, stamped: false, paymentFileId: null }
  }

  // Archive first: the file is räkenskapsinformation (BFL 7 kap. 1 §) and
  // must never be handed out unarchived, so a failed INSERT is a hard error.
  // The id is minted here (no returning select needed) and the row's
  // generated_at is the same instant the run is stamped with.
  const generatedAt = new Date().toISOString()
  const paymentFileId = randomUUID()
  const { error: archiveErr } = await supabase.from('salary_payment_files').insert({
    id: paymentFileId,
    company_id: companyId,
    salary_run_id: runId,
    user_id: input.userId,
    format,
    filename,
    content_type: contentType,
    charset,
    content,
    sha256,
    byte_size: byteSize,
    payment_date: runRow.payment_date,
    employee_count: employees.length,
    total_amount: totalAmount,
    generated_at: generatedAt,
    // The version and, on a new version, the person's confirmation: the row
    // is the audit of who made which version when (20261015230000).
    version,
    previous_not_approved_confirmed: input.newVersion === true,
  })
  if (archiveErr) {
    // The archive refuses a file while a bank payment of the run is live
    // (refuse_salary_payment_file_in_bank_payment, 20261027100000): the file
    // and the bank payments would each pay the month.
    if (isSalaryInBankPaymentError(archiveErr)) {
      return fail('IN_BANK_PAYMENT', format)
    }
    return fail('ARCHIVE_FAILED', format, {}, { cause: archiveErr })
  }

  // Stamp the run. The archive row above is the record; the stamp is
  // bookkeeping about the run, so a failed UPDATE never withholds the file;
  // callers log it.
  const { error: stampErr } = await supabase
    .from('salary_runs')
    .update({ payment_file_format: format, payment_file_generated_at: generatedAt })
    .eq('id', runId)
    .eq('company_id', companyId)

  return { ok: true, ...base, generatedAt, stamped: !stampErr, paymentFileId }
}
