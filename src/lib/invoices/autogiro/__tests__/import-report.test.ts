import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import { depositsFromOwnDebits, importAutogiroReport, markDebitsDebited, type ImportAutogiroReportInput } from '../import-report'
import { CUSTOMER_NUMBER, PAYEE_BG, PAYEE_BG_DIGITS, file, record, reportOpening, zero } from './autogiro-fixture'

type Chain = { method: string; args: unknown[] }[]
const has = (chain: Chain, method: string) => chain.some((c) => c.method === method)

const BG10 = zero(PAYEE_BG_DIGITS, 10)
const SETTINGS = { customer_number: CUSTOMER_NUMBER, bankgiro: PAYEE_BG_DIGITS }

// ── Report builders (positions from Bg Autogiro Teknisk manual, as in reports.test.ts) ──

function payment(date: string, payer: string, ore: number, reference: string, status: string): string {
  return record('82', [[3, date], [11, '0'], [16, zero(payer, 16)], [32, zero(ore, 12)], [44, BG10], [54, reference], [80, status]])
}
function deposit(date: string, serial: string, ore: number, count: number): string {
  return record('15', [[3, zero('30001234567', 35)], [38, date], [46, serial], [51, zero(ore, 18)], [72, zero(count, 8)]])
}
function specEnd(tk15: number, tk82: number, tk17 = 0, tk77 = 0): string {
  return record('09', [[3, '20261130'], [11, '9900'], [15, zero(tk15, 6)], [21, zero(tk82, 12)], [33, zero(0, 6)], [39, zero(0, 12)], [51, zero(tk17, 6)], [57, zero(tk77, 12)]])
}

/** Two debits completed (1 000,00 and 500,00), one stopped for lack of cover (300,00). */
const SPECIFICATION = file([
  reportOpening('BET. SPEC & STOPP TK', '20261130'),
  deposit('20261130', '00021', 150000, 2),
  payment('20261130', '5501', 100000, '10017', '0'),
  payment('20261130', '5502', 50000, '10025', '0'),
  payment('20261130', '5503', 30000, '10033', '1'),
  specEnd(1, 2),
])

const internetBank = (records: string[]) =>
  file([record('51', [[3, '20261102'], [11, '9900'], [15, BG10], [25, 'AG-EMEDGIV']]), ...records, record('59', [[3, '20261102'], [11, '9900'], [15, zero(1, 7)]])])

const INTERNET_BANK = internetBank([
  record('52', [[3, BG10], [13, zero('7001', 16)], [29, '3000000001234567'], [45, '198001011234'], [62, '0']]),
  record('54', [[3, 'Eva Ek']]),
  record('52', [[3, BG10], [13, zero('7002', 16)], [29, '3000000007654321'], [45, '198502022345'], [62, '0']]),
  record('54', [[3, 'Olle Ost']]),
])

const notice = (records: string[]) =>
  file([reportOpening('AG-MEDAVI', '20261103'), ...records, record('09', [[3, '20261103'], [11, '9900'], [15, zero(records.length, 7)]])])
const tk73 = (payer: string, info: string, comment: string) =>
  record('73', [[3, BG10], [13, zero(payer, 16)], [29, '3000000001234567'], [45, '198001011234'], [62, info], [64, comment], [66, '20261103']])

// ── Mock database ──

interface Debit {
  id: string
  invoice_id: string
  payer_number: string
  reference: string
  status: string
  invoice: { invoice_number: string; customer: { name: string } }
}

function setup(options: {
  debits?: Debit[]
  mandates?: Array<{ id: string; customer_id: string | null; payer_number: string; status: string }>
  customers?: Array<{ id: string; name: string; customer_number: string | null; org_number: string | null }>
  seen?: { id: string } | null
  settings?: typeof SETTINGS | null
} = {}) {
  return createTableMockSupabase({
    autogiro_settings: { data: options.settings === undefined ? SETTINGS : options.settings },
    autogiro_files: (chain) => (has(chain, 'insert') ? { data: { id: 'report-1' } } : { data: options.seen ?? null }),
    autogiro_debits: (chain) => (has(chain, 'update') ? { data: null } : { data: options.debits ?? [] }),
    autogiro_mandates: (chain) => (has(chain, 'insert') ? { data: { id: 'man-new' } } : has(chain, 'update') ? { data: null } : { data: options.mandates ?? [] }),
    customers: { data: options.customers ?? [] },
  })
}

const debit = (id: string, payer: string, reference: string, invoiceNumber: string, status = 'sent'): Debit => ({
  id,
  invoice_id: `inv-${invoiceNumber}`,
  payer_number: payer,
  reference,
  status,
  invoice: { invoice_number: invoiceNumber, customer: { name: `Kund ${invoiceNumber}` } },
})

function run(mock: ReturnType<typeof setup>, content: string, extra: Partial<ImportAutogiroReportInput> = {}) {
  return importAutogiroReport(mock.supabase as unknown as SupabaseClient, {
    companyId: 'company-1',
    userId: 'user-1',
    content,
    filename: 'report.txt',
    apply: true,
    today: '2026-11-30',
    ...extra,
  })
}

describe('importAutogiroReport: Betalningsspecifikation', () => {
  const debits = [debit('deb-1', '5501', '10017', '1001'), debit('deb-2', '5502', '10025', '1002'), debit('deb-3', '5503', '10033', '1003')]

  it('marks each debit debited or failed and hands back the deposit to settle, shaped like a BG Max deposit', async () => {
    const mock = setup({ debits })
    const result = await run(mock, SPECIFICATION)
    expect(result).toMatchObject({ ok: true, kind: 'payment_specification', applied: true, repeat: false, file_id: 'report-1' })
    if (!result.ok) return
    expect(result.debits.map((d) => [d.invoice_number, d.outcome])).toEqual([
      ['1001', 'debited'],
      ['1002', 'debited'],
      ['1003', 'failed'],
    ])
    expect(mock.payloads('autogiro_debits', 'update')).toEqual([
      { status: 'debited', status_text: null, status_date: '2026-11-30' },
      { status: 'debited', status_text: null, status_date: '2026-11-30' },
      { status: 'failed', status_text: expect.stringContaining('Täckning saknas'), status_date: '2026-11-30' },
    ])
    expect(result.settlement).toEqual([
      {
        bankgiro: PAYEE_BG,
        bank_account: '30001234567',
        date: '2026-11-30',
        serial: '00021',
        amount: 1500,
        currency: 'SEK',
        payments: [
          expect.objectContaining({ kind: 'payment', amount: 1000, reference: '10017', payer_name: 'Kund 1001', reference_code: '2' }),
          expect.objectContaining({ kind: 'payment', amount: 500, reference: '10025', payer_name: 'Kund 1002' }),
        ],
      },
    ])
    expect(mock.payloads('autogiro_files', 'insert')).toEqual([
      expect.objectContaining({ direction: 'from_bankgirot', kind: 'payment_specification', content: SPECIFICATION, summary: expect.objectContaining({ debited: 2, failed: 1, settled_amount: 1500 }) }),
    ])
  })

  it('previews without writing anything', async () => {
    const mock = setup({ debits })
    const result = await run(mock, SPECIFICATION, { apply: false })
    expect(result).toMatchObject({ ok: true, applied: false, file_id: null })
    expect(mock.payloads('autogiro_debits', 'update')).toEqual([])
    expect(mock.payloads('autogiro_files', 'insert')).toEqual([])
  })

  it('read again: writes nothing, but hands back the deposit for a bank row that synced since', async () => {
    const mock = setup({ debits: debits.map((d) => ({ ...d, status: d.id === 'deb-3' ? 'failed' : 'debited' })), seen: { id: 'report-0' } })
    const result = await run(mock, SPECIFICATION)
    expect(result).toMatchObject({ ok: true, repeat: true, file_id: 'report-0' })
    if (!result.ok) return
    expect(result.settlement[0]!.payments.map((p) => p.payer_name)).toEqual(['Kund 1001', 'Kund 1002'])
    expect(mock.payloads('autogiro_debits', 'update')).toEqual([])
    expect(mock.payloads('autogiro_files', 'insert')).toEqual([])
  })

  it('reports a debit it does not know without touching anything', async () => {
    const mock = setup({ debits: [] })
    const result = await run(mock, SPECIFICATION)
    if (!result.ok) throw new Error('expected ok')
    expect(result.debits.every((d) => d.outcome === 'unknown')).toBe(true)
    expect(mock.payloads('autogiro_debits', 'update')).toEqual([])
  })
})

describe('importAutogiroReport: refusals', () => {
  it('refuses the old layout with what to ask the bank, and a file that is no Autogiro report', async () => {
    const oldLayout = file([record('01', [[3, '20261130'], [11, 'AUTOGIRO'], [19, '9900']])])
    expect(await run(setup(), oldLayout)).toEqual({ ok: false, code: 'AUTOGIRO_REPORT_OLD_LAYOUT' })
    expect(await run(setup(), 'hello\r\n')).toMatchObject({ ok: false, code: 'AUTOGIRO_REPORT_UNKNOWN' })
  })

  it('refuses a report on another bankgiro, without the agreement, and a mandate report read twice', async () => {
    expect(await run(setup({ settings: { customer_number: '1', bankgiro: '9900009' } }), SPECIFICATION)).toMatchObject({
      ok: false,
      code: 'AUTOGIRO_REPORT_WRONG_BANKGIRO',
    })
    expect(await run(setup({ settings: null }), SPECIFICATION)).toEqual({ ok: false, code: 'AUTOGIRO_SETTINGS_MISSING' })
    expect(await run(setup({ seen: { id: 'r' } }), notice([tk73('7001', '04', '32')]))).toEqual({ ok: false, code: 'AUTOGIRO_REPORT_ALREADY_IMPORTED' })
  })

  it('refuses to apply a file with errors, but previews it', async () => {
    const broken = file([reportOpening('BET. SPEC & STOPP TK', '20261130'), deposit('20261130', '00021', 999, 1), payment('20261130', '5501', 100000, '10017', '0'), specEnd(1, 1)])
    expect(await run(setup(), broken)).toMatchObject({ ok: false, code: 'AUTOGIRO_REPORT_HAS_ERRORS' })
    expect(await run(setup(), broken, { apply: false })).toMatchObject({ ok: true, settlement: [] })
  })
})

describe('importAutogiroReport: Medgivanden via Internetbanken', () => {
  const customers = [{ id: 'cust-eva', name: 'Eva Ek', customer_number: '7001', org_number: null }]

  it('previews each payer with the customer whose customer number it typed, approve by default', async () => {
    const result = await run(setup({ customers }), INTERNET_BANK, { apply: false })
    if (!result.ok) throw new Error('expected ok')
    expect(result.mandates).toEqual([
      expect.objectContaining({ payer_number: '7001', payer_name: 'Eva Ek', customer_id: 'cust-eva', linked: true, decision: 'approve', answerable: true, status: 'pending' }),
      expect.objectContaining({ payer_number: '7002', payer_name: 'Olle Ost', customer_id: null, linked: false, decision: 'approve', answerable: true }),
    ])
    expect(result.answer_file).toBeNull()
  })

  it('writes the answer file (blank approves, AV rejects) and never stores it', async () => {
    const mock = setup({ customers })
    const result = await run(mock, INTERNET_BANK, { decisions: { '7001': 'approve', '7002': 'reject' } })
    if (!result.ok) throw new Error('expected ok')
    const lines = result.answer_file!.content.split('\r\n').filter(Boolean)
    expect(result.answer_file!.filename).toBe('autogiro-medgivandesvar-2026-11-30.txt')
    expect(lines).toHaveLength(3)
    expect(lines[1]).toBe(`04${BG10}${zero('7001', 16)}3000${zero('1234567', 12)}198001011234${' '.repeat(20)}${' '.repeat(2)}${' '.repeat(2)}`)
    expect(lines[2]!.slice(76, 78)).toBe('AV')
    expect(mock.payloads('autogiro_mandates', 'insert')).toEqual([
      expect.objectContaining({ payer_number: '7001', status: 'active', customer_id: 'cust-eva', source: 'internet_bank', payer_name: 'Eva Ek' }),
      expect.objectContaining({ payer_number: '7002', status: 'rejected', customer_id: null }),
    ])
    expect(mock.payloads('autogiro_files', 'insert')).toEqual([expect.objectContaining({ kind: 'internet_bank_mandates', content: null })])
  })
})

describe('importAutogiroReport: Medgivandeavisering', () => {
  it('activates a new mandate and links it, and cancels one the payer ended', async () => {
    const mock = setup({
      mandates: [{ id: 'man-2', customer_id: 'cust-olle', payer_number: '7002', status: 'active' }],
      customers: [{ id: 'cust-eva', name: 'Eva Ek', customer_number: '7001', org_number: null }],
    })
    const result = await run(mock, notice([tk73('7001', '04', '32'), tk73('7002', '46', '02')]))
    if (!result.ok) throw new Error('expected ok')
    expect(result.mandates.map((m) => [m.payer_number, m.status, m.customer_id])).toEqual([
      ['7001', 'active', 'cust-eva'],
      ['7002', 'cancelled', 'cust-olle'],
    ])
    expect(mock.payloads('autogiro_mandates', 'insert')).toEqual([expect.objectContaining({ payer_number: '7001', status: 'active', source: 'notice', customer_id: 'cust-eva' })])
    expect(mock.payloads('autogiro_mandates', 'update')).toEqual([expect.objectContaining({ status: 'cancelled', status_changed_on: '2026-11-03' })])
  })

  it('never creates a mandate it only hears was cancelled', async () => {
    const mock = setup()
    await run(mock, notice([tk73('7009', '46', '02')]))
    expect(mock.payloads('autogiro_mandates', 'insert')).toEqual([])
  })
})

describe('depositsFromOwnDebits', () => {
  it('offers each payment day\'s sent debits as one deposit, for a company without report files', async () => {
    const mock = createTableMockSupabase({
      autogiro_settings: { data: SETTINGS },
      autogiro_debits: {
        data: [
          { id: 'deb-1', amount: 1000, debit_date: '2026-11-30', reference: '10017', invoice: { customer: { name: 'Anna' } } },
          { id: 'deb-2', amount: 500.5, debit_date: '2026-11-30', reference: '10025', invoice: { customer: { name: 'Bo' } } },
          { id: 'deb-3', amount: 300, debit_date: '2026-12-01', reference: '10033', invoice: null },
        ],
      },
    })
    const result = await depositsFromOwnDebits(mock.supabase as unknown as SupabaseClient, 'company-1', '2026-12-01')
    if ('ok' in result) throw new Error('expected deposits')
    expect(result.debitIds).toEqual([['deb-1', 'deb-2'], ['deb-3']])
    expect(result.deposits.map((d) => [d.date, d.amount, d.bankgiro, d.payments.map((p) => p.reference)])).toEqual([
      ['2026-11-30', 1500.5, PAYEE_BG, ['10017', '10025']],
      ['2026-12-01', 300, PAYEE_BG, ['10033']],
    ])
    expect(mock.findCall('autogiro_debits', 'lte')).toEqual(['debit_date', '2026-12-01'])
  })

  it('needs the agreement, and marks only debits still sent as debited', async () => {
    const none = createTableMockSupabase({ autogiro_settings: { data: null } })
    expect(await depositsFromOwnDebits(none.supabase as unknown as SupabaseClient, 'company-1', '2026-12-01')).toEqual({ ok: false, code: 'AUTOGIRO_SETTINGS_MISSING' })
    const mock = createTableMockSupabase({ autogiro_debits: { data: null } })
    await markDebitsDebited(mock.supabase as unknown as SupabaseClient, 'company-1', ['deb-1'], '2026-11-30')
    expect(mock.payloads('autogiro_debits', 'update')).toEqual([expect.objectContaining({ status: 'debited', status_date: '2026-11-30' })])
    expect(mock.findCalls('autogiro_debits', 'eq')).toContainEqual(['status', 'sent'])
  })
})
