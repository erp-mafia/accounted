/**
 * Build the salary payment file for a run: ISO 20022 pain.001 XML or the
 * legacy Bankgirot LB text file.
 *
 * Single source of truth for the loading, the preconditions and the
 * `payment_file_format` / `payment_file_generated_at` stamp shared by the
 * dashboard routes (app/api/salary/runs/[id]/payment/{pain001,bg-lb}) and the
 * public endpoint (POST /api/v1/companies/:companyId/salary-runs/:id/payment-file).
 * The HTTP layers only translate the result: the dashboard keeps its legacy
 * `{ error: string }` envelope and download headers, v1 maps codes onto the
 * structured-error catalogue.
 *
 * Preconditions, in the order they are checked (and the order the queries run,
 * which the dashboard route tests depend on):
 *
 *   1. run exists for the company
 *   2. run status is approved, paid or booked
 *   3. company row exists
 *   4. company_settings row (pain.001) / bankgiro (LB) present and valid
 *   5. company IBAN present and BIC present or derivable (pain.001)
 *   6. the run has employees
 *   7. every employee with a positive payout has clearing + account
 *   8. every one of those accounts can be carried by the chosen format
 *      (payeeAccountProblem, the same verdict the generators apply): all
 *      affected employees are named at once, never the account number
 *
 * Employees whose effective net payout is 0 (nollkörning, net fully consumed
 * by a nettolöneavdrag) are left out of the file, so their bank details are
 * not required (see lib/salary/payment/effective-net.ts).
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
import { validateBankgiroNumber } from '@/lib/bankgiro/luhn'
import { generatePain001 } from './pain001-generator'
import type { Pain001CompanyData, Pain001Employee } from './pain001-generator'
import { generateBgLb } from './bg-lb-generator'
import type { BgLbCompanyData, BgLbEmployee } from './bg-lb-generator'
import { effectiveNetPayout } from './effective-net'
import {
  checkEmployeeAccountChecksum,
  describePayeeAccountProblems,
  lookupBicByBankName,
  lookupBicByClearing,
  normalizeBankNumber,
  payeeAccountProblem,
} from './bank-account'

export const SALARY_PAYMENT_FILE_FORMATS = ['pain001', 'bg_lb'] as const
export type SalaryPaymentFileFormat = (typeof SALARY_PAYMENT_FILE_FORMATS)[number]

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
}

export type SalaryPaymentFileErrorCode =
  | 'RUN_NOT_FOUND'
  | 'RUN_NOT_READY'
  | 'COMPANY_NOT_FOUND'
  | 'SETTINGS_MISSING'
  | 'IBAN_MISSING'
  | 'BIC_MISSING'
  | 'BANKGIRO_MISSING'
  | 'BANKGIRO_INVALID'
  | 'NO_EMPLOYEES'
  | 'EMPLOYEE_BANK_MISSING'
  | 'EMPLOYEE_BANK_INVALID'
  | 'GENERATOR_FAILED'
  | 'ARCHIVE_FAILED'
  | 'DB_ERROR'

export type SalaryPaymentFileLoadStage = 'run' | 'company' | 'settings' | 'employees'

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
  totalAmount: number
  /** Non-blocking Swedish annotations the caller should surface. */
  warnings: string[]
  /** Value written to payment_file_generated_at; null on a dry run. */
  generatedAt: string | null
  /** False when the stamp UPDATE failed or was skipped (dry run). The file is still returned. */
  stamped: boolean
  /** Id of the archived salary_payment_files row; null on a dry run (nothing is archived). */
  paymentFileId: string | null
}

export type SalaryPaymentFileResult = SalaryPaymentFileOk | SalaryPaymentFileError

interface RunRow {
  id: string
  status: string
  period_year: number
  period_month: number
  payment_date: string
}

interface SettingsRow {
  company_name: string | null
  iban: string | null
  bic: string | null
  clearing_number: string | null
  bank_name: string | null
  bankgiro: string | null
  preferred_payment_format: string | null
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
    .select('company_name, iban, bic, clearing_number, bank_name, bankgiro, preferred_payment_format')
    .eq('company_id', companyId)
    .maybeSingle()
  if (settingsErr) return fail('DB_ERROR', requestedFormat, {}, { stage: 'settings', cause: settingsErr })

  if (!company) return fail('COMPANY_NOT_FOUND', requestedFormat)

  const settings = (settingsData as SettingsRow | null) ?? null
  const format = resolveFormat(input.format, settings)
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

    pain001Company = {
      // Sender name follows the current company name (company_settings.company_name),
      // not the frozen onboarding companies.name.
      name: settings.company_name || companyRow.name,
      orgNumber: companyRow.org_number || '',
      iban: senderIban,
      bic: senderBic,
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
    .select('*, employee:employees(first_name, last_name, clearing_number, bank_account_number)')
    .eq('salary_run_id', runId)
  if (employeesErr) return fail('DB_ERROR', format, {}, { stage: 'employees', cause: employeesErr })

  const runEmployees = (runEmployeesData as RunEmployeeRow[] | null) ?? []
  if (runEmployees.length === 0) return fail('NO_EMPLOYEES', format)

  // 7. Bank details, but only for employees who actually appear in the file
  // (positive payout). A zero-net employee is filtered out below, so missing
  // bank details for them must not block the file.
  const withNet = runEmployees.map((sre) => ({ sre, effectiveNet: effectiveNetPayout(sre) }))
  const paid = withNet.filter(({ effectiveNet }) => effectiveNet > 0)
  const skipped = withNet.length - paid.length

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

  // 8. Accounts the chosen format cannot carry. Checked for every paid
  // employee before generating, so the user gets the whole list by name in one
  // pass instead of the generator stopping at the first one. `message` is the
  // Swedish text for the HTTP layers; like `employees` it carries names and
  // problem codes, never a clearing or account number.
  const invalidBank = paid.flatMap(({ sre }) => {
    const emp = sre.employee as NonNullable<RunEmployeeRow['employee']>
    const problem = payeeAccountProblem(emp.clearing_number, emp.bank_account_number, format)
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

  if (skipped > 0) {
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
    return { name, clearingNumber, bankAccountNumber, netSalary: effectiveNet }
  })

  const totalAmount = Math.round(employees.reduce((sum, e) => sum + e.netSalary, 0) * 100) / 100
  const periodLabel = `${runRow.period_year}-${String(runRow.period_month).padStart(2, '0')}`

  // Generate. Both generators are pure; they run on a dry run too so a preview
  // that passes means the real call passes (invalid clearing, oversize field).
  let content: string
  let filename: string
  let contentType: SalaryPaymentFileOk['contentType']
  let charset: SalaryPaymentFileOk['charset']
  try {
    if (format === 'pain001') {
      const messageId = `${getBranding().appName.toUpperCase()}-${companyRow.org_number?.replace('-', '')}-${periodLabel}`
      content = generatePain001(pain001Company as Pain001CompanyData, employees as Pain001Employee[], {
        messageId,
        paymentDate: runRow.payment_date,
        periodLabel,
      })
      filename = `pain001_lon_${periodLabel}.xml`
      contentType = 'application/xml'
      charset = 'utf-8'
    } else {
      const result = generateBgLb(bgLbCompany as BgLbCompanyData, employees as BgLbEmployee[], {
        paymentDate: runRow.payment_date,
        periodLabel,
      })
      content = result.content
      filename = result.filename
      contentType = 'text/plain'
      charset = 'iso-8859-1'
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
    employeeCount: employees.length,
    totalAmount,
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
  })
  if (archiveErr) return fail('ARCHIVE_FAILED', format, {}, { cause: archiveErr })

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
