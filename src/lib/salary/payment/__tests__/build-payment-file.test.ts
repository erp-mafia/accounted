/**
 * buildSalaryPaymentFile: the shared loader + precondition gate behind the
 * dashboard payment-file downloads and the v1 payment-file endpoint. The
 * generators are real; only the Supabase client is a queued mock, so the
 * query order asserted here is the order the dashboard route tests rely on.
 */

import { createHash } from 'crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { buildSalaryPaymentFile, SALARY_PAYMENT_FILE_ALLOWED_STATUSES } from '../build-payment-file'

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
  employee: { first_name: 'Anna', last_name: 'A', clearing_number: '6000', bank_account_number: '1234567' },
}

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

  it('loads run, company, settings, employees in that order, archives the file and stamps the run', async () => {
    const { supabase, enqueueMany, calls, findCall } = client()
    enqueueMany([
      { data: run },
      { data: company },
      { data: settings },
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
    // BIC derived from the clearing (Handelsbanken) since none is saved.
    expect(result.content).toContain('<BIC>HANDSESS</BIC>')
    expect(result.warnings.some((w) => w.includes('HANDSESS'))).toBe(true)

    const tables = calls.filter((c) => c.method === 'select' || c.method === 'update').map((c) => c.table)
    expect(tables).toEqual(['salary_runs', 'companies', 'company_settings', 'salary_run_employees', 'salary_runs'])
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

  it('requires IBAN, then a saved or derivable BIC, for pain001', async () => {
    const a = client()
    a.enqueueMany([{ data: run }, { data: company }, { data: { ...settings, iban: '  ' } }])
    expect(await buildSalaryPaymentFile(a.supabase, { companyId: COMPANY_ID, runId: RUN_ID, userId: USER_ID, format: 'pain001' })).toMatchObject({
      ok: false,
      code: 'IBAN_MISSING',
      details: { field: 'iban' },
    })

    const b = client()
    b.enqueueMany([
      { data: run },
      { data: company },
      { data: { ...settings, bic: null, clearing_number: null, bank_name: 'Okänd Bank' } },
    ])
    expect(await buildSalaryPaymentFile(b.supabase, { companyId: COMPANY_ID, runId: RUN_ID, userId: USER_ID, format: 'pain001' })).toMatchObject({
      ok: false,
      code: 'BIC_MISSING',
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
    enqueueMany([{ data: run }, { data: company }, { data: settings }, { data: [] }])
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
    a.enqueueMany([{ data: run }, { data: company }, { data: settings }, { data: [anna, zeroNet] }, { data: null }])
    const okResult = await buildSalaryPaymentFile(a.supabase, { companyId: COMPANY_ID, runId: RUN_ID, userId: USER_ID, format: 'pain001' })
    expect(okResult.ok).toBe(true)
    if (!okResult.ok) return
    expect(okResult.employeeCount).toBe(1)
    expect(okResult.warnings.some((w) => w.includes('0 kr'))).toBe(true)

    const noAccount = { ...anna, employee: { ...anna.employee, bank_account_number: null } }
    const b = client()
    b.enqueueMany([{ data: run }, { data: company }, { data: settings }, { data: [noAccount] }])
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

  // ── Employee accounts the chosen format cannot carry ──────────
  // Invented numbers. `sara` is the support-ticket shape: a 5-digit Swedbank
  // clearing with a 10-digit account needs 11 positions in the 10-wide
  // Bankgirot LB account field ("Numeriskt fält för långt (11 > 10): 996...").
  const sara = {
    ...anna,
    employee_id: 'emp-2',
    employee: { first_name: 'Sara', last_name: 'S', clearing_number: '8327-9', bank_account_number: '9612345678' },
  }
  const sven = {
    ...anna,
    employee_id: 'emp-3',
    employee: { first_name: 'Sven', last_name: 'T', clearing_number: '81059', bank_account_number: '9698765432' },
  }
  // Accepted by the old 5-11 digit rule; names no payable account in any format.
  const legacy = {
    ...anna,
    employee_id: 'emp-4',
    employee: { first_name: 'Lena', last_name: 'L', clearing_number: '5037', bank_account_number: '96123456789' },
  }

  it('refuses the LB file by NAME for every employee whose account does not fit, before generating', async () => {
    const { supabase, enqueueMany, calls } = client()
    enqueueMany([{ data: run }, { data: company }, { data: settings }, { data: [anna, sara, sven] }])
    const result = await buildSalaryPaymentFile(supabase, { companyId: COMPANY_ID, runId: RUN_ID, userId: USER_ID, format: 'bg_lb' })

    expect(result).toMatchObject({
      ok: false,
      code: 'EMPLOYEE_BANK_INVALID',
      format: 'bg_lb',
      details: {
        employee_count: 2,
        employees: [
          { employee_id: 'emp-2', name: 'Sara S', problem: 'bg_lb_account_too_long' },
          { employee_id: 'emp-3', name: 'Sven T', problem: 'bg_lb_account_too_long' },
        ],
      },
    })
    if (result.ok) return
    const message = String(result.details.message)
    expect(message).toBe(
      'Sara S, Sven T: kontonumret ryms inte i Bankgirot LB-filen (femsiffrigt clearingnummer med tiosiffrigt kontonummer). Skapa betalfilen som ISO 20022 (pain.001) i stället.',
    )
    // Nothing in the failure carries a clearing or account number.
    const serialized = JSON.stringify(result.details)
    for (const secret of ['9612345678', '9698765432', '996', '8327', '8105']) {
      expect(serialized).not.toContain(secret)
    }
    expect(calls.filter((c) => c.method === 'insert')).toHaveLength(0)
    expect(calls.filter((c) => c.method === 'update')).toHaveLength(0)
  })

  it('pays the same employees with pain.001, which has no fixed-width account field', async () => {
    const { supabase, enqueueMany } = client()
    enqueueMany([{ data: run }, { data: company }, { data: settings }, { data: [anna, sara, sven] }, { data: null }, { data: null }])
    const result = await buildSalaryPaymentFile(supabase, { companyId: COMPANY_ID, runId: RUN_ID, userId: USER_ID, format: 'pain001' })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.employeeCount).toBe(3)
    expect(result.content).toContain('<Id>99612345678</Id>')
  })

  it('names an employee whose stored details name no payable account, in every format', async () => {
    for (const format of ['pain001', 'bg_lb'] as const) {
      const { supabase, enqueueMany, calls } = client()
      enqueueMany([{ data: run }, { data: company }, { data: settings }, { data: [anna, legacy] }])
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
    enqueueMany([{ data: run }, { data: company }, { data: settings }, { data: [badClearing] }])
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
    enqueueMany([{ data: run }, { data: company }, { data: settings }, { data: [sara] }])
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
    enqueueMany([{ data: run }, { data: company }, { data: settings }, { data: [anna] }])
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
