/**
 * buildSalaryPaymentFile: the shared loader + precondition gate behind the
 * dashboard payment-file downloads and the v1 payment-file endpoint. The
 * generators are real; only the Supabase client is a queued mock, so the
 * query order asserted here is the order the dashboard route tests rely on.
 */

import { createHash } from 'crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  createQueuedMockSupabase,
  createTableMockSupabase,
  makePayingCashAccount,
  payingAccountReads,
  payingCashAccountsTable,
} from '@/tests/helpers'
import {
  buildSalaryPaymentFile,
  SALARY_PAYMENT_FILE_ALLOWED_STATUSES,
  SWEDBANK_IDS_MISSING_SV,
  salaryPaymentFileRefusal,
  salaryPaymentMessageId,
} from '../build-payment-file'
import { NORDEA_AGREEMENT_ID_MISSING_SV, NORDEA_SIGNER_ID_MISSING_SV } from '@/lib/payments/nordea'

const COMPANY_ID = 'company-1'
const RUN_ID = 'run-1'
const USER_ID = 'user-1'

/** SHA-256 hex over `content` encoded the way the download sends it. */
function digest(content: string, encoding: 'utf8' | 'latin1'): string {
  return createHash('sha256').update(Buffer.from(content, encoding)).digest('hex')
}

const run = { id: RUN_ID, status: 'approved', period_year: 2026, period_month: 4, payment_date: '2026-04-24' }
const company = { name: 'Onboarding Name AB', org_number: '556000-0000' }
const settings = {
  company_name: 'Bolaget AB',
  iban: 'SE4550000000058398257466',
  bic: null,
  clearing_number: '6000',
  bank_name: null,
  bankgiro: '5050-1055',
  preferred_payment_format: 'bg_lb',
}
const anna = {
  employee_id: 'emp-1',
  net_salary: 20000,
  tax_withheld: 6000,
  tax_withheld_override: null,
  employee: { first_name: 'Anna', last_name: 'A', clearing_number: '6000', bank_account_number: '1234567', specification_number: 1 },
}

/** The paying account's two reads for the seeded 1930 without an IBAN: it pays from the settings IBAN. */
const ONLY_1930 = payingAccountReads()
const cashAccount = makePayingCashAccount

function client() {
  const mock = createQueuedMockSupabase()
  return { ...mock, supabase: mock.supabase as unknown as Parameters<typeof buildSalaryPaymentFile>[0] }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('buildSalaryPaymentFile', () => {
  it('exposes the status gate the dashboard routes use', () => {
    expect([...SALARY_PAYMENT_FILE_ALLOWED_STATUSES]).toEqual(['approved', 'paid', 'booked'])
  })

  it('loads run, company, settings, the paying account, employees in that order, archives the file and stamps the run', async () => {
    const { supabase, enqueueMany, calls, findCall } = client()
    enqueueMany([
      { data: run },
      { data: company },
      { data: settings },
      ...ONLY_1930,
      { data: [anna] },
      { data: null }, // salary_payment_files insert
      { data: null }, // salary_runs update
    ])

    const result = await buildSalaryPaymentFile(supabase, { companyId: COMPANY_ID, runId: RUN_ID, userId: USER_ID, format: 'pain001' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.format).toBe('pain001')
    expect(result.filename).toBe('pain001_lon_2026-04.xml')
    expect(result.contentType).toBe('application/xml')
    expect(result.charset).toBe('utf-8')
    expect(result.employeeCount).toBe(1)
    expect(result.totalAmount).toBe(20000)
    expect(result.paymentDate).toBe('2026-04-24')
    expect(result.stamped).toBe(true)
    expect(typeof result.generatedAt).toBe('string')
    // Sender name follows company_settings.company_name, not companies.name.
    expect(result.content).toContain('<Nm>Bolaget AB</Nm>')
    expect(result.content).not.toContain('Onboarding Name AB')
    // BIC derived from the IBAN's bank code (SEB) since none is saved.
    expect(result.content).toContain('<BIC>ESSESESS</BIC>')
    expect(result.warnings.some((w) => w.includes('ESSESESS'))).toBe(true)
    expect(result.payer.cashAccount).toEqual({
      cash_account_id: 'ca-1930',
      name: 'Företagskonto (SEK)',
      ledger_account: '1930',
      iban_last4: '7466',
    })

    const tables = calls.filter((c) => c.method === 'select' || c.method === 'update').map((c) => c.table)
    expect(tables).toEqual([
      'salary_runs',
      'companies',
      'company_settings',
      'cash_accounts',
      'cash_accounts',
      'salary_run_employees',
      'salary_runs',
    ])
    const stamp = findCall('salary_runs', 'update')?.[0] as Record<string, unknown>
    expect(stamp.payment_file_format).toBe('pain001')
    expect(typeof stamp.payment_file_generated_at).toBe('string')

    // Archived before the stamp, as one WORM row carrying the exact content
    // and a digest over its UTF-8 bytes (the encoding the download sends).
    const writes = calls
      .filter((c) => c.method === 'insert' || c.method === 'update')
      .map((c) => `${c.table}.${c.method}`)
    expect(writes).toEqual(['salary_payment_files.insert', 'salary_runs.update'])
    const archived = findCall('salary_payment_files', 'insert')?.[0] as Record<string, unknown>
    expect(archived).toMatchObject({
      id: result.paymentFileId,
      company_id: COMPANY_ID,
      salary_run_id: RUN_ID,
      user_id: USER_ID,
      format: 'pain001',
      filename: 'pain001_lon_2026-04.xml',
      content_type: 'application/xml',
      charset: 'utf-8',
      content: result.content,
      sha256: digest(result.content, 'utf8'),
      byte_size: Buffer.byteLength(result.content, 'utf8'),
      payment_date: '2026-04-24',
      employee_count: 1,
      total_amount: 20000,
      generated_at: result.generatedAt,
    })
    expect(result.sha256).toBe(archived.sha256)
    expect(result.byteSize).toBe(archived.byte_size)
    expect(typeof result.paymentFileId).toBe('string')
    expect(stamp.payment_file_generated_at).toBe(archived.generated_at)
  })

  it('falls back to company_settings.preferred_payment_format when no format is given', async () => {
    const { supabase, enqueueMany, findCall } = client()
    // A Latin-1 name (ö) makes the encoding observable: the LB digest is over
    // ISO 8859-1 bytes and differs from a UTF-8 digest of the same string.
    const sjoberg = { ...anna, employee: { ...anna.employee, last_name: 'Sjöberg' } }
    enqueueMany([{ data: run }, { data: company }, { data: settings }, { data: [sjoberg] }, { data: null }, { data: null }])

    const result = await buildSalaryPaymentFile(supabase, { companyId: COMPANY_ID, runId: RUN_ID, userId: USER_ID })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.format).toBe('bg_lb')
    expect(result.filename).toBe('bg_lb_lon_2026-04.txt')
    expect(result.charset).toBe('iso-8859-1')
    expect(result.content.startsWith('11')).toBe(true)
    expect(result.content).toContain('Sjöberg')
    expect(result.sha256).toBe(digest(result.content, 'latin1'))
    expect(result.sha256).not.toBe(digest(result.content, 'utf8'))
    expect(result.byteSize).toBe(Buffer.byteLength(result.content, 'latin1'))
    const archived = findCall('salary_payment_files', 'insert')?.[0] as Record<string, unknown>
    expect(archived).toMatchObject({
      format: 'bg_lb',
      content_type: 'text/plain',
      charset: 'iso-8859-1',
      sha256: result.sha256,
      byte_size: result.byteSize,
    })
  })

  it('defaults to pain001 when there is no settings row and reports SETTINGS_MISSING', async () => {
    const { supabase, enqueueMany } = client()
    enqueueMany([{ data: run }, { data: company }, { data: null }])

    const result = await buildSalaryPaymentFile(supabase, { companyId: COMPANY_ID, runId: RUN_ID, userId: USER_ID })
    expect(result).toMatchObject({ ok: false, code: 'SETTINGS_MISSING', format: 'pain001' })
  })

  it('reports RUN_NOT_FOUND and RUN_NOT_READY before touching anything else', async () => {
    const a = client()
    a.enqueueMany([{ data: null }])
    expect(await buildSalaryPaymentFile(a.supabase, { companyId: COMPANY_ID, runId: RUN_ID, userId: USER_ID, format: 'pain001' })).toMatchObject({
      ok: false,
      code: 'RUN_NOT_FOUND',
    })
    expect(a.calls.map((c) => c.table)).not.toContain('companies')

    const b = client()
    b.enqueueMany([{ data: { ...run, status: 'review' } }])
    const notReady = await buildSalaryPaymentFile(b.supabase, { companyId: COMPANY_ID, runId: RUN_ID, userId: USER_ID, format: 'pain001' })
    expect(notReady).toMatchObject({
      ok: false,
      code: 'RUN_NOT_READY',
      details: { current_status: 'review', allowed_statuses: ['approved', 'paid', 'booked'] },
    })
  })

  it('reports COMPANY_NOT_FOUND after loading settings (the dashboard query order)', async () => {
    const { supabase, enqueueMany } = client()
    enqueueMany([{ data: run }, { data: null }, { data: settings }])
    const result = await buildSalaryPaymentFile(supabase, { companyId: COMPANY_ID, runId: RUN_ID, userId: USER_ID, format: 'pain001' })
    expect(result).toMatchObject({ ok: false, code: 'COMPANY_NOT_FOUND' })
  })

  it('requires an IBAN, then a saved or derivable BIC, on the paying account for pain001', async () => {
    const account = { cash_account_id: 'ca-1930', name: 'Företagskonto (SEK)', ledger_account: '1930' }
    const a = client()
    a.enqueueMany([{ data: run }, { data: company }, { data: { ...settings, iban: '  ' } }, ...ONLY_1930])
    expect(await buildSalaryPaymentFile(a.supabase, { companyId: COMPANY_ID, runId: RUN_ID, userId: USER_ID, format: 'pain001' })).toMatchObject({
      ok: false,
      code: 'IBAN_MISSING',
      details: {
        field: 'iban',
        account: { ...account, iban_last4: null },
        message:
          'Betalfilen betalar från Företagskonto (SEK) (1930), men kontot saknar IBAN. Fyll i kontots IBAN under Inställningar → Fakturor, Bankkonton för kundfakturor.',
      },
    })

    // A foreign IBAN names no bank by its code, and nothing else does either.
    const b = client()
    b.enqueueMany([{ data: run }, { data: company }, { data: { ...settings, iban: 'DK5000400440116243', bic: null } }, ...ONLY_1930])
    expect(await buildSalaryPaymentFile(b.supabase, { companyId: COMPANY_ID, runId: RUN_ID, userId: USER_ID, format: 'pain001' })).toMatchObject({
      ok: false,
      code: 'BIC_MISSING',
      details: { field: 'bic', account: { ...account, iban_last4: '6243' } },
    })
  })

  it('requires a valid bankgiro for bg_lb (missing row counts as missing bankgiro)', async () => {
    const a = client()
    a.enqueueMany([{ data: run }, { data: company }, { data: null }])
    expect(await buildSalaryPaymentFile(a.supabase, { companyId: COMPANY_ID, runId: RUN_ID, userId: USER_ID, format: 'bg_lb' })).toMatchObject({
      ok: false,
      code: 'BANKGIRO_MISSING',
    })

    const b = client()
    b.enqueueMany([{ data: run }, { data: company }, { data: { ...settings, bankgiro: '123-4567' } }])
    expect(await buildSalaryPaymentFile(b.supabase, { companyId: COMPANY_ID, runId: RUN_ID, userId: USER_ID, format: 'bg_lb' })).toMatchObject({
      ok: false,
      code: 'BANKGIRO_INVALID',
      details: { field: 'bankgiro', value: '123-4567' },
    })
  })

  it('reports NO_EMPLOYEES for an empty roster', async () => {
    const { supabase, enqueueMany } = client()
    enqueueMany([{ data: run }, { data: company }, { data: settings }, ...ONLY_1930, { data: [] }])
    expect(await buildSalaryPaymentFile(supabase, { companyId: COMPANY_ID, runId: RUN_ID, userId: USER_ID, format: 'pain001' })).toMatchObject({
      ok: false,
      code: 'NO_EMPLOYEES',
    })
  })

  it('blocks on missing bank details only for employees with a positive payout', async () => {
    const zeroNet = {
      ...anna,
      employee_id: 'emp-0',
      net_salary: 0,
      tax_withheld: 0,
      employee: { first_name: 'Noll', last_name: 'N', clearing_number: null, bank_account_number: null },
    }
    const a = client()
    a.enqueueMany([{ data: run }, { data: company }, { data: settings }, ...ONLY_1930, { data: [anna, zeroNet] }, { data: null }])
    const okResult = await buildSalaryPaymentFile(a.supabase, { companyId: COMPANY_ID, runId: RUN_ID, userId: USER_ID, format: 'pain001' })
    expect(okResult.ok).toBe(true)
    if (!okResult.ok) return
    expect(okResult.employeeCount).toBe(1)
    expect(okResult.warnings.some((w) => w.includes('0 kr'))).toBe(true)

    const noAccount = { ...anna, employee: { ...anna.employee, bank_account_number: null } }
    const b = client()
    b.enqueueMany([{ data: run }, { data: company }, { data: settings }, ...ONLY_1930, { data: [noAccount] }])
    const blocked = await buildSalaryPaymentFile(b.supabase, { companyId: COMPANY_ID, runId: RUN_ID, userId: USER_ID, format: 'pain001' })
    expect(blocked).toMatchObject({
      ok: false,
      code: 'EMPLOYEE_BANK_MISSING',
      details: { employee_count: 1, employees: [{ employee_id: 'emp-1', name: 'Anna A' }] },
    })
    expect(b.calls.filter((c) => c.method === 'update')).toHaveLength(0)
  })

  it('honors tax_withheld_override in the payout (effective net)', async () => {
    const { supabase, enqueueMany } = client()
    enqueueMany([
      { data: run },
      { data: company },
      { data: settings },
      ...ONLY_1930,
      { data: [{ ...anna, tax_withheld_override: 5500 }] },
      { data: null },
    ])
    const result = await buildSalaryPaymentFile(supabase, { companyId: COMPANY_ID, runId: RUN_ID, userId: USER_ID, format: 'pain001' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.totalAmount).toBe(20500)
    expect(result.content).toContain('<InstdAmt Ccy="SEK">20500.00</InstdAmt>')
  })

  it('maps a generator throw to GENERATOR_FAILED with a Swedish message and no stamp', async () => {
    const badDate = { ...run, payment_date: '24/4 2026' }
    const { supabase, enqueueMany, calls } = client()
    enqueueMany([{ data: badDate }, { data: company }, { data: settings }, { data: [anna] }])
    const result = await buildSalaryPaymentFile(supabase, { companyId: COMPANY_ID, runId: RUN_ID, userId: USER_ID, format: 'bg_lb' })
    expect(result).toMatchObject({ ok: false, code: 'GENERATOR_FAILED' })
    if (result.ok) return
    expect(String(result.details.message)).toContain('Ogiltigt datum')
    expect(calls.filter((c) => c.method === 'update')).toHaveLength(0)
  })

  // ── Employee accounts: the support-ticket shapes ──────────────
  // Invented numbers. `sara` and `sven` are the support-ticket shape (crm#174):
  // a 5-digit Swedbank clearing with a 10-digit account, 11 account digits,
  // which the old TK54 layout's 10-wide field refused.
  const sara = {
    ...anna,
    employee_id: 'emp-2',
    employee: { first_name: 'Sara', last_name: 'S', clearing_number: '8327-9', bank_account_number: '9612345678', specification_number: 2 },
  }
  const sven = {
    ...anna,
    employee_id: 'emp-3',
    employee: { first_name: 'Sven', last_name: 'T', clearing_number: '81059', bank_account_number: '9698765432', specification_number: 3 },
  }
  // Accepted by the old 5-11 digit rule; names no payable account in any format.
  const legacy = {
    ...anna,
    employee_id: 'emp-4',
    employee: { first_name: 'Lena', last_name: 'L', clearing_number: '5037', bank_account_number: '96123456789', specification_number: 4 },
  }

  it('carries a 5-digit Swedbank clearing with a 10-digit account in the LB file (crm#174)', async () => {
    const { supabase, enqueueMany, calls } = client()
    enqueueMany([{ data: run }, { data: company }, { data: settings }, { data: [anna, sara, sven] }, { data: null }, { data: null }])
    const result = await buildSalaryPaymentFile(supabase, { companyId: COMPANY_ID, runId: RUN_ID, userId: USER_ID, format: 'bg_lb' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.employeeCount).toBe(3)
    const lines = result.content.split('\r\n').filter((l) => l.length > 0)
    expect(lines.map((l) => l.slice(0, 2))).toEqual(['11', '40', '14', '40', '14', '40', '14', '29'])
    // Sara: TK40 with clearing 8327 and the 11 account digits in the 12-wide field.
    expect(lines[3].slice(12, 28)).toBe('8327099612345678')
    // The utbetalningsnummer is built on the specification number, so it is
    // the same for the same employee on every run and distinct per employee.
    const payeeNumbers = [lines[1], lines[3], lines[5]].map((l) => l.slice(6, 12))
    expect(new Set(payeeNumbers).size).toBe(3)
    expect(calls.filter((c) => c.method === 'insert')).toHaveLength(1)
  })

  it('pays the same employees with pain.001, which has no fixed-width account field', async () => {
    const { supabase, enqueueMany } = client()
    enqueueMany([{ data: run }, { data: company }, { data: settings }, ...ONLY_1930, { data: [anna, sara, sven] }, { data: null }, { data: null }])
    const result = await buildSalaryPaymentFile(supabase, { companyId: COMPANY_ID, runId: RUN_ID, userId: USER_ID, format: 'pain001' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.employeeCount).toBe(3)
    expect(result.content).toContain('<Id>99612345678</Id>')
  })

  it('names an employee whose stored details name no payable account, in every format', async () => {
    for (const format of ['pain001', 'bg_lb'] as const) {
      const { supabase, enqueueMany, calls } = client()
      enqueueMany([
        { data: run },
        { data: company },
        { data: settings },
        ...(format === 'pain001' ? ONLY_1930 : []),
        { data: [anna, legacy] },
      ])
      const result = await buildSalaryPaymentFile(supabase, { companyId: COMPANY_ID, runId: RUN_ID, userId: USER_ID, format })
      expect(result).toMatchObject({
        ok: false,
        code: 'EMPLOYEE_BANK_INVALID',
        details: { employee_count: 1, employees: [{ employee_id: 'emp-4', name: 'Lena L', problem: 'account_format' }] },
      })
      if (result.ok) return
      expect(String(result.details.message)).toBe(
        'Lena L: kontonumret är ogiltigt (5-10 siffror, utan clearingnummer). Rätta bankuppgifterna.',
      )
      expect(JSON.stringify(result.details)).not.toContain('96123456789')
      expect(calls.filter((c) => c.method === 'insert')).toHaveLength(0)
    }
  })

  it('reports an invalid clearing as EMPLOYEE_BANK_INVALID, not as a raw generator throw', async () => {
    const badClearing = { ...anna, employee: { ...anna.employee, clearing_number: '12' } }
    const { supabase, enqueueMany, calls } = client()
    enqueueMany([{ data: run }, { data: company }, { data: settings }, ...ONLY_1930, { data: [badClearing] }])
    const result = await buildSalaryPaymentFile(supabase, { companyId: COMPANY_ID, runId: RUN_ID, userId: USER_ID, format: 'pain001' })
    expect(result).toMatchObject({
      ok: false,
      code: 'EMPLOYEE_BANK_INVALID',
      details: { employees: [{ employee_id: 'emp-1', name: 'Anna A', problem: 'clearing_format' }] },
    })
    expect(calls.filter((c) => c.method === 'update')).toHaveLength(0)
  })

  it('a dry run reports the same refusal, so a preview before payday is truthful', async () => {
    const { supabase, enqueueMany } = client()
    enqueueMany([{ data: run }, { data: company }, { data: settings }, { data: [legacy] }])
    const result = await buildSalaryPaymentFile(supabase, {
      companyId: COMPANY_ID,
      runId: RUN_ID,
      userId: USER_ID,
      format: 'bg_lb',
      dryRun: true,
    })
    expect(result).toMatchObject({ ok: false, code: 'EMPLOYEE_BANK_INVALID' })
  })

  it('ignores the bank details of an employee with no payout, as for missing details', async () => {
    const zeroNet = { ...legacy, net_salary: 0, tax_withheld: 0 }
    const { supabase, enqueueMany } = client()
    enqueueMany([{ data: run }, { data: company }, { data: settings }, { data: [anna, zeroNet] }, { data: null }, { data: null }])
    const result = await buildSalaryPaymentFile(supabase, { companyId: COMPANY_ID, runId: RUN_ID, userId: USER_ID, format: 'bg_lb' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.employeeCount).toBe(1)
  })

  it('dry run builds the file but never stamps', async () => {
    const { supabase, enqueueMany, calls } = client()
    enqueueMany([{ data: run }, { data: company }, { data: settings }, ...ONLY_1930, { data: [anna] }])
    const result = await buildSalaryPaymentFile(supabase, {
      companyId: COMPANY_ID,
      runId: RUN_ID,
      userId: USER_ID,
      format: 'pain001',
      dryRun: true,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.content).toContain('<Document')
    expect(result.generatedAt).toBeNull()
    expect(result.stamped).toBe(false)
    // The digest is a pure function of the content, so the preview carries
    // it; nothing is archived and nothing is stamped.
    expect(result.sha256).toBe(digest(result.content, 'utf8'))
    expect(result.paymentFileId).toBeNull()
    expect(calls.filter((c) => c.method === 'insert')).toHaveLength(0)
    expect(calls.filter((c) => c.method === 'update')).toHaveLength(0)
  })

  it('fails with ARCHIVE_FAILED and never stamps when the archive insert fails', async () => {
    const { supabase, enqueueMany, calls } = client()
    enqueueMany([
      { data: run },
      { data: company },
      { data: settings },
      ...ONLY_1930,
      { data: [anna] },
      { data: null, error: { code: '42501', message: 'permission denied' } },
    ])
    const result = await buildSalaryPaymentFile(supabase, { companyId: COMPANY_ID, runId: RUN_ID, userId: USER_ID, format: 'pain001' })
    expect(result).toMatchObject({ ok: false, code: 'ARCHIVE_FAILED', format: 'pain001' })
    if (result.ok) return
    expect(result.cause).toMatchObject({ code: '42501' })
    // The file must not be handed out unarchived, and the run is not stamped.
    expect(calls.filter((c) => c.method === 'update')).toHaveLength(0)
  })

  it('refuses the file while a bank payment of the run is live: the archive says so by its hint', async () => {
    const { supabase, enqueueMany, calls } = client()
    enqueueMany([
      { data: run },
      { data: company },
      { data: settings },
      ...ONLY_1930,
      { data: [anna] },
      { data: null, error: { code: '23514', message: 'salary run is paid through the bank', hint: 'salary_run_in_bank_payment' } },
    ])
    const result = await buildSalaryPaymentFile(supabase, { companyId: COMPANY_ID, runId: RUN_ID, userId: USER_ID, format: 'pain001' })
    expect(result).toMatchObject({ ok: false, code: 'IN_BANK_PAYMENT', format: 'pain001' })
    expect(calls.filter((c) => c.method === 'update')).toHaveLength(0)
    if (result.ok) return
    expect(salaryPaymentFileRefusal(result)).toEqual({ code: 'SALARY_RUN_IN_BANK_PAYMENT', details: { format: 'pain001' } })
  })

  it('returns DB_ERROR with the stage when a read fails', async () => {
    const { supabase, enqueueMany } = client()
    enqueueMany([{ data: null, error: { code: 'XX000', message: 'boom' } }])
    const result = await buildSalaryPaymentFile(supabase, { companyId: COMPANY_ID, runId: RUN_ID, userId: USER_ID, format: 'pain001' })
    expect(result).toMatchObject({ ok: false, code: 'DB_ERROR', stage: 'run' })
  })

  it('still returns the file when the stamp UPDATE fails (stamped=false)', async () => {
    const { supabase, enqueueMany } = client()
    enqueueMany([
      { data: run },
      { data: company },
      { data: settings },
      ...ONLY_1930,
      { data: [anna] },
      { data: null }, // archive insert succeeds
      { data: null, error: { code: '42501', message: 'permission denied' } },
    ])
    const result = await buildSalaryPaymentFile(supabase, { companyId: COMPANY_ID, runId: RUN_ID, userId: USER_ID, format: 'pain001' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.stamped).toBe(false)
    expect(result.content).toContain('<Document')
  })
})

// Nordea refuses a pain.001 whose InitgPty is not its Signer ID, and rejects
// one whose Dbtr is not its CCM agreement id (crm#1530): the builder asks
// for both before anything is generated and passes them on.
describe('buildSalaryPaymentFile for a Nordea debtor', () => {
  const nordeaSettings = { ...settings, bic: 'NDEASESS', nordea_signer_id: 'NB10000123456', nordea_agreement_id: 'NB123456' }

  it('refuses NORDEA_SIGNER_ID_MISSING with a Swedish message, before loading employees', async () => {
    const { supabase, enqueueMany, calls } = client()
    enqueueMany([{ data: run }, { data: company }, { data: { ...nordeaSettings, nordea_signer_id: null } }, ...ONLY_1930])
    const result = await buildSalaryPaymentFile(supabase, { companyId: COMPANY_ID, runId: RUN_ID, userId: USER_ID, format: 'pain001' })

    expect(result).toMatchObject({
      ok: false,
      code: 'NORDEA_SIGNER_ID_MISSING',
      format: 'pain001',
      details: { fields: ['nordea_signer_id'], message: NORDEA_SIGNER_ID_MISSING_SV },
    })
    expect(calls.map((c) => c.table)).not.toContain('salary_run_employees')
    expect(calls.filter((c) => c.method === 'insert' || c.method === 'update')).toHaveLength(0)
  })

  it('refuses NORDEA_AGREEMENT_ID_MISSING when only the CCM agreement id is missing', async () => {
    const { supabase, enqueueMany, calls } = client()
    enqueueMany([{ data: run }, { data: company }, { data: { ...nordeaSettings, nordea_agreement_id: null } }, ...ONLY_1930])
    const result = await buildSalaryPaymentFile(supabase, { companyId: COMPANY_ID, runId: RUN_ID, userId: USER_ID, format: 'pain001' })

    expect(result).toMatchObject({
      ok: false,
      code: 'NORDEA_AGREEMENT_ID_MISSING',
      format: 'pain001',
      details: { fields: ['nordea_agreement_id'], message: NORDEA_AGREEMENT_ID_MISSING_SV },
    })
    expect(calls.map((c) => c.table)).not.toContain('salary_run_employees')
  })

  it('reads the settings again without the agreement id while its column is not there yet', async () => {
    const { supabase, enqueueMany, calls } = client()
    enqueueMany([
      { data: run },
      { data: company },
      { data: null, error: { code: '42703', message: 'column company_settings.nordea_agreement_id does not exist' } },
      { data: { ...nordeaSettings, nordea_agreement_id: undefined } },
      ...ONLY_1930,
    ])
    const result = await buildSalaryPaymentFile(supabase, { companyId: COMPANY_ID, runId: RUN_ID, userId: USER_ID, format: 'pain001' })

    expect(result).toMatchObject({ ok: false, code: 'NORDEA_AGREEMENT_ID_MISSING' })
    const selects = calls.filter((c) => c.table === 'company_settings' && c.method === 'select').map((c) => String(c.args[0]))
    expect(selects).toHaveLength(2)
    expect(selects[1]).not.toContain('nordea_agreement_id')
  })

  it('maps the refusal to the missing-bank-details code for v1, MCP and the bank list', () => {
    const refusal = salaryPaymentFileRefusal({
      ok: false,
      code: 'NORDEA_SIGNER_ID_MISSING',
      format: 'pain001',
      details: { fields: ['nordea_signer_id'], message: NORDEA_SIGNER_ID_MISSING_SV },
    })
    expect(refusal).toMatchObject({
      code: 'SALARY_RUN_PAYMENT_FILE_MISSING_BANK_DETAILS',
      reason: 'NORDEA_SIGNER_ID_MISSING',
      details: { format: 'pain001', problem: 'nordea_signer_id_missing', fields: ['nordea_signer_id'] },
    })
  })

  it('names the sender by the Signer ID (CUST) and the debtor by the CCM agreement id (BANK)', async () => {
    const { supabase, enqueueMany } = client()
    enqueueMany([
      { data: run },
      { data: company },
      { data: nordeaSettings },
      ...ONLY_1930,
      { data: [anna] },
      { data: null },
      { data: null },
    ])
    const result = await buildSalaryPaymentFile(supabase, { companyId: COMPANY_ID, runId: RUN_ID, userId: USER_ID, format: 'pain001' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.content).toContain('<Othr><Id>NB10000123456</Id><SchmeNm><Cd>CUST</Cd></SchmeNm></Othr>')
    const debtor = result.content.match(/<Dbtr>[\s\S]*?<\/Dbtr>/)![0]
    expect(debtor).toContain('<Othr><Id>NB123456</Id><SchmeNm><Cd>BANK</Cd></SchmeNm></Othr>')
    expect(debtor).toContain('<Ctry>SE</Ctry>')
  })
})

// Swedbank refuses a pain.001 without its own SignerID and Corporate Pay id
// (crm#1117): the builder asks for them before anything is generated, and
// passes them, the company town and each employee's town to the generator.
describe('buildSalaryPaymentFile for a Swedbank debtor', () => {
  const swedbankSettings = {
    ...settings,
    bic: 'SWEDSESS',
    city: 'Uppsala',
    swedbank_signer_id: '260637712ORI0003',
    swedbank_corporate_pay_id: '260637712CPO0001',
  }
  const annaInArboga = { ...anna, employee: { ...anna.employee, city: 'Arboga' } }

  it('refuses SWEDBANK_IDS_MISSING with a Swedish message, before loading employees', async () => {
    const { supabase, enqueueMany, calls } = client()
    enqueueMany([
      { data: run },
      { data: company },
      { data: { ...swedbankSettings, swedbank_signer_id: null, swedbank_corporate_pay_id: '  ' } },
      ...ONLY_1930,
    ])
    const result = await buildSalaryPaymentFile(supabase, { companyId: COMPANY_ID, runId: RUN_ID, userId: USER_ID, format: 'pain001' })

    expect(result).toMatchObject({
      ok: false,
      code: 'SWEDBANK_IDS_MISSING',
      format: 'pain001',
      details: { fields: ['swedbank_signer_id', 'swedbank_corporate_pay_id'], message: SWEDBANK_IDS_MISSING_SV },
    })
    expect(calls.map((c) => c.table)).not.toContain('salary_run_employees')
    expect(calls.filter((c) => c.method === 'insert' || c.method === 'update')).toHaveLength(0)
  })

  it('also asks a company whose paying account is at a savings bank by its IBAN, naming only the missing id', async () => {
    const { supabase, enqueueMany } = client()
    enqueueMany([
      { data: run },
      { data: company },
      // The settings still name another bank: the paying account decides.
      { data: { ...swedbankSettings, bic: 'HANDSESS', swedbank_corporate_pay_id: null } },
      ...payingAccountReads([cashAccount({ payee_iban: 'SE6480000832790000012345' })]),
    ])
    const result = await buildSalaryPaymentFile(supabase, { companyId: COMPANY_ID, runId: RUN_ID, userId: USER_ID, format: 'pain001' })
    expect(result).toMatchObject({ ok: false, code: 'SWEDBANK_IDS_MISSING', details: { fields: ['swedbank_corporate_pay_id'] } })
  })

  it('maps the refusal to the missing-bank-details code for v1, MCP and the bank list', () => {
    const refusal = salaryPaymentFileRefusal({
      ok: false,
      code: 'SWEDBANK_IDS_MISSING',
      format: 'pain001',
      details: { fields: ['swedbank_signer_id'], message: SWEDBANK_IDS_MISSING_SV },
    })
    expect(refusal).toMatchObject({
      code: 'SALARY_RUN_PAYMENT_FILE_MISSING_BANK_DETAILS',
      reason: 'SWEDBANK_IDS_MISSING',
      details: { format: 'pain001', problem: 'swedbank_ids_missing', fields: ['swedbank_signer_id'] },
    })
  })

  it("writes Swedbank's form: its ids, the day before payday, and both towns", async () => {
    const { supabase, enqueueMany, calls, findCall } = client()
    enqueueMany([
      { data: run },
      { data: company },
      { data: swedbankSettings },
      ...ONLY_1930,
      { data: [annaInArboga] },
      { data: null },
      { data: null },
    ])
    const result = await buildSalaryPaymentFile(supabase, { companyId: COMPANY_ID, runId: RUN_ID, userId: USER_ID, format: 'pain001' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.content).toContain('<Othr><Id>260637712ORI0003</Id><SchmeNm><Cd>BANK</Cd></SchmeNm></Othr>')
    expect(result.content).toContain('<Othr><Id>260637712CPO0001</Id><SchmeNm><Cd>BANK</Cd></SchmeNm></Othr>')
    expect(result.content).toContain('<TwnNm>Uppsala</TwnNm>')
    expect(result.content).toContain('<TwnNm>Arboga</TwnNm>')
    // Payday Friday 24 April: Swedbank debits Thursday.
    expect(result.content).toContain('<ReqdExctnDt>2026-04-23</ReqdExctnDt>')
    // The run, the result and the archive keep payday.
    expect(result.paymentDate).toBe('2026-04-24')
    const archived = findCall('salary_payment_files', 'insert')?.[0] as Record<string, unknown>
    expect(archived.payment_date).toBe('2026-04-24')
    // The ids, the town and the employee town are read in the queries the
    // dashboard route tests already order.
    const tables = calls.filter((c) => c.method === 'select' || c.method === 'update').map((c) => c.table)
    expect(tables).toEqual([
      'salary_runs',
      'companies',
      'company_settings',
      'cash_accounts',
      'cash_accounts',
      'salary_run_employees',
      'salary_runs',
    ])
  })

  it('leaves every other bank as before: Swedbank ids on file change nothing there', async () => {
    const { supabase, enqueueMany } = client()
    enqueueMany([
      { data: run },
      { data: company },
      { data: { ...swedbankSettings, bic: 'HANDSESS' } },
      ...ONLY_1930,
      { data: [annaInArboga] },
      { data: null },
      { data: null },
    ])
    const result = await buildSalaryPaymentFile(supabase, { companyId: COMPANY_ID, runId: RUN_ID, userId: USER_ID, format: 'pain001' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.content).toContain('<ReqdExctnDt>2026-04-24</ReqdExctnDt>')
    expect(result.content).not.toContain('ORI0003')
    expect(result.content).not.toContain('<PstlAdr>')
    expect(result.content).toContain('<Othr><Id>5560000000</Id></Othr>')
  })
})

describe('the sender a pain.001 names', () => {
  const pain001 = async (companyRow: Record<string, unknown>, settingsRow: Record<string, unknown>) => {
    const { supabase, enqueueMany } = client()
    enqueueMany([{ data: run }, { data: companyRow }, { data: settingsRow }, ...ONLY_1930, { data: [anna] }, { data: null }, { data: null }])
    const result = await buildSalaryPaymentFile(supabase, { companyId: COMPANY_ID, runId: RUN_ID, userId: USER_ID, format: 'pain001' })
    expect(result.ok).toBe(true)
    return result as Extract<typeof result, { ok: true }>
  }

  it('reads a number held in settings alone, as ten digits, into the file, its ids and the bank list', async () => {
    const result = await pain001({ ...company, org_number: null }, { ...settings, org_number: '165566778899' })
    expect(result.content).toContain('<Id>5566778899</Id>')
    expect(result.content).toContain('-5566778899-2026-04</MsgId>')
    expect(result.payer.orgNumber).toBe('556677-8899')
  })

  it('keeps the id a 12-digit company row has always given, so a re-download stays one message', async () => {
    const result = await pain001({ ...company, org_number: '165566778899' }, { ...settings, org_number: '5566778899' })
    expect(result.content).toContain('-165566778899-2026-04</MsgId>')
    expect(result.content).toContain('<Id>5566778899</Id>')
  })

  it('never writes the word undefined into the message id', async () => {
    const result = await pain001({ ...company, org_number: null }, settings)
    expect(result.content).not.toContain('undefined')
  })
})

// crm#1219: a corrected file for a run whose first file already reached the
// bank needs new ids, or the bank refuses it as a duplicate. Only with the
// person's confirmation that the earlier file was not approved.
describe('payment file versions', () => {
  const ids = (xml: string) => ({
    msgId: xml.match(/<MsgId>([^<]+)<\/MsgId>/)![1],
    pmtInfId: xml.match(/<PmtInfId>([^<]+)<\/PmtInfId>/)![1],
    endToEndIds: [...xml.matchAll(/<EndToEndId>([^<]+)<\/EndToEndId>/g)].map((m) => m[1]),
    instrIds: [...xml.matchAll(/<InstrId>([^<]+)<\/InstrId>/g)].map((m) => m[1]),
  })
  const QUEUE = (runRow: Record<string, unknown>) => [
    { data: runRow },
    { data: company },
    { data: settings },
    ...ONLY_1930,
    { data: [anna] },
    { data: null }, // salary_payment_files insert
    { data: null }, // salary_runs update
  ]

  it('refuses a new version without the confirmation, before reading anything', async () => {
    for (const confirm of [undefined, false]) {
      const { supabase, calls } = client()
      const result = await buildSalaryPaymentFile(supabase, {
        companyId: COMPANY_ID,
        runId: RUN_ID,
        userId: USER_ID,
        format: 'pain001',
        newVersion: true,
        confirmPreviousNotApproved: confirm,
      })
      expect(result).toMatchObject({ ok: false, code: 'NEW_VERSION_UNCONFIRMED' })
      expect(calls).toHaveLength(0)
      if (!result.ok) {
        expect(salaryPaymentFileRefusal(result)).toEqual({ code: 'SALARY_RUN_PAYMENT_FILE_NEW_VERSION_UNCONFIRMED' })
      }
    }
  })

  it('V1 to V2: new MsgId, PmtInfId, InstrId and EndToEndId, archived with the version and the confirmation', async () => {
    const first = client()
    first.enqueueMany(QUEUE({ ...run, payment_file_version: 1 }))
    const v1 = await buildSalaryPaymentFile(first.supabase, { companyId: COMPANY_ID, runId: RUN_ID, userId: USER_ID, format: 'pain001' })

    const second = client()
    second.enqueueMany(QUEUE({ ...run, payment_file_version: 1 }))
    const v2 = await buildSalaryPaymentFile(second.supabase, {
      companyId: COMPANY_ID,
      runId: RUN_ID,
      userId: USER_ID,
      format: 'pain001',
      newVersion: true,
      confirmPreviousNotApproved: true,
    })

    expect(v1.ok && v2.ok).toBe(true)
    if (!v1.ok || !v2.ok) return
    expect(v1.version).toBe(1)
    expect(v2.version).toBe(2)
    expect(v2.filename).toBe('pain001_lon_2026-04_v2.xml')

    const a = ids(v1.content)
    const b = ids(v2.content)
    expect(a.msgId).not.toContain('-V')
    expect(b).toEqual({
      msgId: 'LON-5560000000-2026-04-V2',
      pmtInfId: 'LON-5560000000-2026-04-V2-PMT',
      endToEndIds: ['LON-5560000000-2026-04-V2-TX0001'],
      instrIds: ['LON-5560000000-2026-04-V2-TX0001'],
    })
    expect(b.msgId).not.toBe(a.msgId)
    expect(b.pmtInfId).not.toBe(a.pmtInfId)
    expect(b.endToEndIds[0]).not.toBe(a.endToEndIds[0])
    // The banklista names each payment by the id the file carries.
    expect(v2.payees.map((p) => p.reference)).toEqual(b.endToEndIds)

    expect(first.findCall('salary_payment_files', 'insert')?.[0]).toMatchObject({
      version: 1,
      previous_not_approved_confirmed: false,
    })
    // The audit: who, when, which version, and that the confirmation was given.
    expect(second.findCall('salary_payment_files', 'insert')?.[0]).toMatchObject({
      user_id: USER_ID,
      generated_at: v2.generatedAt,
      filename: 'pain001_lon_2026-04_v2.xml',
      version: 2,
      previous_not_approved_confirmed: true,
      content: v2.content,
    })
  })

  it('the default download returns the latest version, without a new confirmation', async () => {
    const { supabase, enqueueMany, findCall } = client()
    enqueueMany(QUEUE({ ...run, payment_file_version: 3 }))

    const result = await buildSalaryPaymentFile(supabase, { companyId: COMPANY_ID, runId: RUN_ID, userId: USER_ID, format: 'pain001' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.version).toBe(3)
    expect(ids(result.content).msgId).toBe('LON-5560000000-2026-04-V3')
    expect(findCall('salary_payment_files', 'insert')?.[0]).toMatchObject({
      version: 3,
      previous_not_approved_confirmed: false,
    })
  })

  it('a dry run previews the next version without archiving or stamping', async () => {
    const { supabase, enqueueMany, calls } = client()
    enqueueMany(QUEUE({ ...run, payment_file_version: 1 }).slice(0, 6))

    const result = await buildSalaryPaymentFile(supabase, {
      companyId: COMPANY_ID,
      runId: RUN_ID,
      userId: USER_ID,
      format: 'pain001',
      dryRun: true,
      newVersion: true,
      confirmPreviousNotApproved: true,
    })

    expect(result).toMatchObject({ ok: true, version: 2, paymentFileId: null })
    expect(calls.filter((c) => c.method === 'insert' || c.method === 'update')).toHaveLength(0)
  })

  it('refuses a new version of a Bankgirot LB file, which has no message id', async () => {
    const { supabase, enqueueMany } = client()
    enqueueMany(QUEUE({ ...run, payment_file_version: 1 }))

    const result = await buildSalaryPaymentFile(supabase, {
      companyId: COMPANY_ID,
      runId: RUN_ID,
      userId: USER_ID,
      format: 'bg_lb',
      newVersion: true,
      confirmPreviousNotApproved: true,
    })

    expect(result).toMatchObject({ ok: false, code: 'NEW_VERSION_UNSUPPORTED', format: 'bg_lb' })
  })

  it('keeps the period and the version in every id up to version 99, within Max35Text', async () => {
    for (const version of [2, 9, 10, 99]) {
      const id = salaryPaymentMessageId('ACCOUNTED', '5590000000', '2026-10', version)
      expect(id).toBe(`LON-5590000000-2026-10-V${version}`)
      expect(`${id}-TX0001`.length).toBeLessThanOrEqual(35)
    }
    expect(salaryPaymentMessageId('ACCOUNTED', '5590000000', '2026-10', 1)).toBe('ACCOUNTED-5590000000-2026-10')
  })
})

// crm#1483: the file paid from the savings account while the verifikat
// credited 1930. The file now pays from the account the salary verifikat
// credits. Answered per table (cash_accounts by what the chain asked), so
// the same test reads the file the old builder wrote from company_settings.
describe('the account the file pays from (crm#1483)', () => {
  /** 1930's IBAN as the bank reports it: the account the books say the net pay leaves. */
  const IBAN_1930 = 'SE4550000000058398257466'
  /** The savings account 1931: the IBAN SEK invoices print, so the one company_settings mirrors. */
  const IBAN_1931 = 'SE7150000000058391234567'
  const SEB = { bank_name: 'SEB', bic: 'ESSESESS' }

  const connected1930 = cashAccount({
    name: 'Företagskonto',
    bank_connection_id: 'bc-1',
    iban: IBAN_1930,
    bank_connection: SEB,
  })
  const savings1931 = cashAccount({
    id: 'ca-1931',
    name: 'Sparkonto',
    ledger_account: '1931',
    is_primary: false,
    bank_connection_id: 'bc-1',
    iban: IBAN_1931,
    payee_iban: IBAN_1931,
    invoice_payee: true,
    bank_connection: SEB,
  })

  function tableClient(opts: {
    accounts: Array<ReturnType<typeof cashAccount>>
    runRow?: Record<string, unknown>
    settingsRow?: Record<string, unknown>
    postedEntries?: unknown[]
  }) {
    const mock = createTableMockSupabase({
      salary_runs: [{ data: opts.runRow ?? run }, { data: null }],
      companies: { data: company },
      company_settings: { data: opts.settingsRow ?? { ...settings, iban: IBAN_1931, bic: 'ESSESESS' } },
      journal_entries: { data: opts.postedEntries ?? [] },
      cash_accounts: payingCashAccountsTable(opts.accounts),
      salary_run_employees: { data: [anna] },
      salary_payment_files: { data: null },
    })
    return { ...mock, supabase: mock.supabase as unknown as Parameters<typeof buildSalaryPaymentFile>[0] }
  }

  const debtorIban = (xml: string) => xml.match(/<DbtrAcct>[\s\S]*?<IBAN>([^<]+)<\/IBAN>/)?.[1]

  it('pays from the primary the verifikat credits, not the savings account invoices print', async () => {
    const { supabase } = tableClient({ accounts: [connected1930, savings1931] })

    const result = await buildSalaryPaymentFile(supabase, { companyId: COMPANY_ID, runId: RUN_ID, userId: USER_ID, format: 'pain001' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(debtorIban(result.content)).toBe(IBAN_1930)
    expect(result.content).not.toContain(IBAN_1931)
    expect(result.payer).toMatchObject({
      account: IBAN_1930,
      cashAccount: { cash_account_id: 'ca-1930', name: 'Företagskonto', ledger_account: '1930', iban_last4: '7466' },
    })
    // The bank connection names the bank: nothing was guessed.
    expect(result.warnings.some((w) => w.includes('härleddes'))).toBe(false)
  })

  it('pays a booked run from the account its verifikat credits, though the primary changed since', async () => {
    // Booked while the savings account was primary: the verifikat credits
    // 1931. 1930 is primary today. The file must follow the books.
    const postedSalary = {
      id: 'je-salary',
      description: 'Lön 2026-04',
      voucher_series: 'K',
      voucher_number: 12,
      lines: [
        { account_number: '7210', line_description: 'Lön 2026-04: Löner', debit_amount: 26000, credit_amount: 0 },
        { account_number: '2710', line_description: 'Lön 2026-04: Personalskatt', debit_amount: 0, credit_amount: 6000 },
        { account_number: '1931', line_description: 'Lön 2026-04: Nettolön', debit_amount: 0, credit_amount: 20000 },
      ],
    }
    const { supabase, calls } = tableClient({
      accounts: [connected1930, savings1931],
      runRow: { ...run, status: 'booked', salary_entry_id: 'je-salary' },
      postedEntries: [postedSalary],
    })

    const result = await buildSalaryPaymentFile(supabase, { companyId: COMPANY_ID, runId: RUN_ID, userId: USER_ID, format: 'pain001' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(debtorIban(result.content)).toBe(IBAN_1931)
    expect(result.payer.cashAccount).toMatchObject({ cash_account_id: 'ca-1931', ledger_account: '1931' })
    // The posted verifikat decided; the primary was never asked.
    expect(calls.some((c) => c.table === 'cash_accounts' && c.method === 'eq' && c.args[0] === 'is_primary')).toBe(false)
  })

  it("keeps the settings IBAN for a company whose only bank account has none of its own", async () => {
    const { supabase } = tableClient({ accounts: [cashAccount()], settingsRow: { ...settings, bic: 'HANDSESS' } })

    const result = await buildSalaryPaymentFile(supabase, { companyId: COMPANY_ID, runId: RUN_ID, userId: USER_ID, format: 'pain001' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(debtorIban(result.content)).toBe(settings.iban)
    // The BIC saved beside that IBAN, as before: no lookup warning.
    expect(result.content).toContain('<BIC>HANDSESS</BIC>')
    expect(result.warnings.some((w) => w.includes('härleddes'))).toBe(false)
  })

  it('refuses, naming the account, when the primary has no IBAN and the company has other accounts', async () => {
    const { supabase, calls } = tableClient({ accounts: [cashAccount({ name: 'Företagskonto' }), savings1931] })

    const result = await buildSalaryPaymentFile(supabase, { companyId: COMPANY_ID, runId: RUN_ID, userId: USER_ID, format: 'pain001' })

    expect(result).toMatchObject({
      ok: false,
      code: 'IBAN_MISSING',
      details: {
        field: 'iban',
        account: { cash_account_id: 'ca-1930', name: 'Företagskonto', ledger_account: '1930', iban_last4: null },
        message:
          'Betalfilen betalar från Företagskonto (1930), men kontot saknar IBAN. Fyll i kontots IBAN under Inställningar → Fakturor, Bankkonton för kundfakturor.',
      },
    })
    if (result.ok) return
    // v1, MCP and the bank list carry the account in the refusal details.
    expect(salaryPaymentFileRefusal(result)).toMatchObject({
      code: 'SALARY_RUN_PAYMENT_FILE_MISSING_BANK_DETAILS',
      reason: 'IBAN_MISSING',
      details: { problem: 'iban_missing', account: { cash_account_id: 'ca-1930', ledger_account: '1930' } },
    })
    expect(calls.some((c) => c.table === 'salary_run_employees')).toBe(false)
  })

  it('maps a failed account read to DB_ERROR at the account stage', async () => {
    const mock = createTableMockSupabase({
      salary_runs: { data: run },
      companies: { data: company },
      company_settings: { data: settings },
      cash_accounts: { error: { code: '57014', message: 'canceling statement due to statement timeout' } },
    })
    const result = await buildSalaryPaymentFile(mock.supabase as unknown as Parameters<typeof buildSalaryPaymentFile>[0], {
      companyId: COMPANY_ID,
      runId: RUN_ID,
      userId: USER_ID,
      format: 'pain001',
    })
    expect(result).toMatchObject({ ok: false, code: 'DB_ERROR', stage: 'account' })
  })
})

describe('payment file of a correction run', () => {
  const correctionRun = { ...run, corrects_run_id: 'run-0' }
  const bertil = {
    ...anna,
    employee_id: 'emp-2',
    net_salary: 18000,
    tax_withheld: 5000,
    employee: { first_name: 'Bertil', last_name: 'B', clearing_number: '6000', bank_account_number: '7654321', specification_number: 2 },
  }
  const cecilia = {
    ...anna,
    employee_id: 'emp-3',
    net_salary: 12000,
    tax_withheld: 3000,
    employee: { first_name: 'Cecilia', last_name: 'C', clearing_number: '6000', bank_account_number: '1112223', specification_number: 3 },
  }
  /** The chain's roster as the chain query reads it (one row id each). */
  const chainRows = (...rows: Array<typeof anna>) => rows.map((r, i) => ({ id: `sre-${i}`, ...r }))

  it('reads the corrected run after the employees and writes only the difference, naming the overpaid', async () => {
    const { supabase, enqueueMany, calls, findCall } = client()
    enqueueMany([
      { data: correctionRun },
      { data: company },
      { data: settings },
      ...ONLY_1930,
      // Anna up 1 500, Bertil down 250, Cecilia unchanged, Dora new.
      {
        data: [
          { ...anna, net_salary: 21500 },
          { ...bertil, net_salary: 17750 },
          cecilia,
          { ...anna, employee_id: 'emp-4', net_salary: 9000, employee: { ...anna.employee, first_name: 'Dora', last_name: 'D', specification_number: 4 } },
        ],
      },
      { data: { id: 'run-0', corrects_run_id: null } },
      { data: chainRows(anna, bertil, cecilia) },
      { data: null }, // salary_payment_files insert
      { data: null }, // salary_runs update
    ])

    const result = await buildSalaryPaymentFile(supabase, { companyId: COMPANY_ID, runId: RUN_ID, userId: USER_ID, format: 'pain001' })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.payees.map((p) => [p.name, p.amount])).toEqual([
      ['Anna A', 1500],
      ['Dora D', 9000],
    ])
    expect(result.totalAmount).toBe(10500)
    expect(result.employeeCount).toBe(2)
    expect(result.content).toContain('<InstdAmt Ccy="SEK">1500.00</InstdAmt>')
    expect(result.content).not.toContain('<InstdAmt Ccy="SEK">21500.00</InstdAmt>')
    expect(result.correction).toEqual({
      correctsRunId: 'run-0',
      overpaid: [{ employee_id: 'emp-2', name: 'Bertil B', amount: 250 }],
    })
    expect(result.warnings).toContain('Rättelse: endast skillnaden mot den tidigare körningen betalas ut.')
    expect(result.warnings).toContain('1 anställd(a) utan skillnad mot den tidigare körningen ingår inte i filen.')
    expect(result.warnings.some((w) => w.startsWith('Enligt rättelsen har Bertil B (') && w.includes('för mycket'))).toBe(true)
    // The archived row carries the file's own figures: the difference.
    expect(findCall('salary_payment_files', 'insert')?.[0]).toMatchObject({ employee_count: 2, total_amount: 10500 })

    const reads = calls.filter((c) => c.method === 'select').map((c) => c.table)
    expect(reads).toEqual([
      'salary_runs',
      'companies',
      'company_settings',
      'cash_accounts',
      'cash_accounts',
      'salary_run_employees',
      'salary_runs',
      'salary_run_employees',
    ])
    expect(findCall('salary_run_employees', 'in')).toEqual(['salary_run_id', ['run-0']])
  })

  it('makes no file when the correction raises nobody, and names the overpaid', async () => {
    const { supabase, enqueueMany, calls } = client()
    enqueueMany([
      { data: correctionRun },
      { data: company },
      { data: settings },
      { data: [{ ...anna, net_salary: 19000 }] },
      { data: { id: 'run-0', corrects_run_id: null } },
      { data: chainRows(anna, bertil) },
    ])
    const result = await buildSalaryPaymentFile(supabase, { companyId: COMPANY_ID, runId: RUN_ID, userId: USER_ID, format: 'bg_lb' })
    expect(result).toEqual({
      ok: false,
      code: 'NOTHING_TO_PAY',
      format: 'bg_lb',
      details: {
        correction: {
          corrects_run_id: 'run-0',
          overpaid: [
            { employee_id: 'emp-1', name: 'Anna A', amount: 1000 },
            // Removed from the correction: everything paid before.
            { employee_id: 'emp-2', name: 'Bertil B', amount: 18000 },
          ],
        },
      },
    })
    expect(calls.filter((c) => c.method === 'insert' || c.method === 'update')).toHaveLength(0)
    if (result.ok) return
    expect(salaryPaymentFileRefusal(result)).toEqual({
      code: 'SALARY_RUN_PAYMENT_FILE_NOTHING_TO_PAY',
      details: { format: 'bg_lb', ...result.details },
    })
  })

  it('refuses with DB_ERROR (stage correction) when the corrected run cannot be read, never paying the full net', async () => {
    const { supabase, enqueueMany, calls } = client()
    enqueueMany([{ data: correctionRun }, { data: company }, { data: settings }, ...ONLY_1930, { data: [anna] }, { data: null }])
    const result = await buildSalaryPaymentFile(supabase, { companyId: COMPANY_ID, runId: RUN_ID, userId: USER_ID, format: 'pain001' })
    expect(result).toMatchObject({ ok: false, code: 'DB_ERROR', stage: 'correction' })
    expect(calls.filter((c) => c.method === 'insert')).toHaveLength(0)
  })

  it('leaves an ordinary run without a correction', async () => {
    const { supabase, enqueueMany } = client()
    enqueueMany([{ data: run }, { data: company }, { data: settings }, ...ONLY_1930, { data: [anna] }, { data: null }, { data: null }])
    const result = await buildSalaryPaymentFile(supabase, { companyId: COMPANY_ID, runId: RUN_ID, userId: USER_ID, format: 'pain001' })
    expect(result).toMatchObject({ ok: true, correction: null, totalAmount: 20000 })
  })
})
