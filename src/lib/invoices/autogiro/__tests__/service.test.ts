import { beforeEach, describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import {
  addExistingMandate,
  cancelMandate,
  createDebitFile,
  linkMandate,
  loadDueAutogiroInvoices,
  saveAutogiroSettings,
  withdrawDebitFile,
} from '../service'
import { CUSTOMER_NUMBER, PAYEE_BG_DIGITS } from './autogiro-fixture'

type Chain = { method: string; args: unknown[] }[]
const has = (chain: Chain, method: string) => chain.some((c) => c.method === method)
const arg = (chain: Chain, method: string, column: string) => chain.find((c) => c.method === method && c.args[0] === column)?.args[1]

const SETTINGS = { customer_number: CUSTOMER_NUMBER, bankgiro: PAYEE_BG_DIGITS }

/** An issued invoice that announced Autogiro. OCR of 1001 is 10017. */
function invoice(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inv-1',
    invoice_number: '1001',
    invoice_date: '2026-11-02',
    due_date: '2026-11-30',
    status: 'sent',
    document_type: 'invoice',
    credited_invoice_id: null,
    total: 1000,
    currency: 'SEK',
    ore_rounding: null,
    deduction_total: 0,
    paid_amount: 0,
    remaining_amount: 1000,
    autogiro_payer_number: '5501',
    customer_id: 'cust-1',
    customer: { name: 'Anna Andersson' },
    ...overrides,
  }
}

function setup(options: {
  settings?: typeof SETTINGS | null
  invoices?: ReturnType<typeof invoice>[]
  liveDebits?: Array<{ invoice_id: string }>
  deliveries?: Array<{ invoice_id: string; sent_at: string }>
  mandates?: Array<{ id: string; payer_number: string }>
  debitInsert?: { data?: unknown; error?: unknown }
} = {}) {
  return createTableMockSupabase({
    autogiro_settings: (chain) => (has(chain, 'upsert') ? { data: null } : { data: options.settings === undefined ? SETTINGS : options.settings }),
    invoices: { data: options.invoices ?? [invoice()] },
    invoice_deliveries: { data: options.deliveries ?? [] },
    company_settings: { data: { ore_rounding: false } },
    autogiro_mandates: { data: options.mandates ?? [{ id: 'man-1', payer_number: '5501' }] },
    autogiro_debits: (chain) => {
      if (has(chain, 'insert')) return (options.debitInsert as never) ?? { data: [{ id: 'deb-1' }] }
      if (has(chain, 'update')) return { data: null }
      return { data: options.liveDebits ?? [] }
    },
    autogiro_files: (chain) => (has(chain, 'insert') ? { data: { id: 'file-1' } } : { data: null }),
  })
}

const db = (mock: ReturnType<typeof setup>) => mock.supabase as unknown as SupabaseClient

beforeEach(() => {
  delete process.env.AUTOGIRO_COMPANY_IDS
})

describe('saveAutogiroSettings', () => {
  it('stores the Kundnummer and the bankgiro, digits only', async () => {
    const mock = setup()
    const result = await saveAutogiroSettings(db(mock), 'company-1', { customer_number: '012 345', bankgiro: `${PAYEE_BG_DIGITS.slice(0, 3)}-${PAYEE_BG_DIGITS.slice(3)}` })
    expect(result).toEqual({ ok: true, settings: { customer_number: '12345', bankgiro: PAYEE_BG_DIGITS } })
    expect(mock.payloads('autogiro_settings', 'upsert')).toEqual([{ company_id: 'company-1', customer_number: '12345', bankgiro: PAYEE_BG_DIGITS }])
  })

  it('refuses a bankgiro whose check digit is wrong, and a Kundnummer longer than 6 digits', async () => {
    const wrongCheck = PAYEE_BG_DIGITS.slice(0, -1) + String((Number(PAYEE_BG_DIGITS.slice(-1)) + 1) % 10)
    expect(await saveAutogiroSettings(db(setup()), 'company-1', { customer_number: '1', bankgiro: wrongCheck })).toMatchObject({
      ok: false,
      code: 'AUTOGIRO_SETTINGS_INVALID',
      details: { field: 'bankgiro' },
    })
    expect(await saveAutogiroSettings(db(setup()), 'company-1', { customer_number: '1234567', bankgiro: PAYEE_BG_DIGITS })).toMatchObject({
      ok: false,
      details: { field: 'customer_number' },
    })
  })
})

describe('loadDueAutogiroInvoices', () => {
  it('debits the customer\'s share of a RUT invoice on the due date', async () => {
    const mock = setup({
      invoices: [invoice({ total: 1000, deduction_total: 500, remaining_amount: 500 })],
      deliveries: [{ invoice_id: 'inv-1', sent_at: '2026-11-03T08:00:00Z' }, { invoice_id: 'inv-1', sent_at: '2026-11-02T08:00:00Z' }],
    })
    const [due] = await loadDueAutogiroInvoices(db(mock), 'company-1', '2026-11-20')
    expect(due).toMatchObject({
      invoice_id: 'inv-1',
      payer_number: '5501',
      mandate_id: 'man-1',
      notice_date: '2026-11-02',
      debit_date: '2026-11-30',
      amount: 500,
      reference: '10017',
      blocker: null,
    })
  })

  it('says why an invoice cannot go in: mandate no longer active, nothing left, no usable OCR', async () => {
    const mock = setup({
      invoices: [
        invoice({ id: 'inv-a', autogiro_payer_number: '9999' }),
        invoice({ id: 'inv-b', status: 'partially_paid', paid_amount: 1000, remaining_amount: 0 }),
        invoice({ id: 'inv-c', invoice_number: '12345678901234567' }),
      ],
    })
    const due = await loadDueAutogiroInvoices(db(mock), 'company-1', '2026-11-20')
    expect(due.map((d) => [d.invoice_id, d.blocker])).toEqual([
      ['inv-a', 'mandate_not_active'],
      ['inv-b', 'nothing_to_pay'],
      ['inv-c', 'reference_unusable'],
    ])
  })

  it('leaves out an invoice already in a live debit', async () => {
    const mock = setup({ liveDebits: [{ invoice_id: 'inv-1' }] })
    expect(await loadDueAutogiroInvoices(db(mock), 'company-1', '2026-11-20')).toEqual([])
  })

  it('reads only issued invoices that announced Autogiro', async () => {
    const mock = setup()
    await loadDueAutogiroInvoices(db(mock), 'company-1', '2026-11-20')
    expect(mock.findCall('invoices', 'not')).toEqual(['autogiro_payer_number', 'is', null])
    expect(mock.findCall('invoices', 'in')).toEqual(['status', ['sent', 'overdue', 'partially_paid']])
  })
})

describe('createDebitFile', () => {
  it('writes one TK82 per invoice on its payment day, records the debits and stores the file', async () => {
    const mock = setup()
    const result = await createDebitFile(db(mock), 'company-1', 'user-1', { today: '2026-11-20' })
    expect(result).toMatchObject({ ok: true, file: { id: 'file-1', filename: 'autogiro-betalningar-2026-11-20.txt' }, debits: 1, total: 1000 })

    expect(mock.payloads('autogiro_debits', 'insert')).toEqual([
      [
        {
          company_id: 'company-1',
          invoice_id: 'inv-1',
          mandate_id: 'man-1',
          payer_number: '5501',
          amount: 1000,
          debit_date: '2026-11-30',
          reference: '10017',
          status: 'sent',
        },
      ],
    ])
    const stored = mock.payloads('autogiro_files', 'insert')[0] as { content: string; kind: string; direction: string }
    expect(stored).toMatchObject({ kind: 'debits', direction: 'to_bankgirot' })
    const lines = stored.content.split('\r\n').filter(Boolean)
    expect(lines).toHaveLength(2)
    expect(lines[0]!.startsWith('0120261120AUTOGIRO')).toBe(true)
    expect(lines[1]).toBe(
      `8220261130${'0'}${' '.repeat(4)}${'5501'.padStart(16, '0')}${'100000'.padStart(12, '0')}${PAYEE_BG_DIGITS.padStart(10, '0')}${'10017'.padEnd(16)}${' '.repeat(11)}`,
    )
    expect(mock.payloads('autogiro_debits', 'update')).toEqual([{ file_id: 'file-1' }])
  })

  it('refuses when no invoice can go in, and without the agreement', async () => {
    expect(await createDebitFile(db(setup({ invoices: [invoice({ autogiro_payer_number: '9999' })] })), 'company-1', 'user-1', { today: '2026-11-20' })).toMatchObject({
      ok: false,
      code: 'AUTOGIRO_NOTHING_TO_DEBIT',
    })
    expect(await createDebitFile(db(setup({ settings: null })), 'company-1', 'user-1', { today: '2026-11-20' })).toMatchObject({
      ok: false,
      code: 'AUTOGIRO_SETTINGS_MISSING',
    })
  })

  it('refuses an invoice another request just put in a file, before any file is stored', async () => {
    const mock = setup({ debitInsert: { error: { code: '23505', message: 'duplicate key' } } })
    expect(await createDebitFile(db(mock), 'company-1', 'user-1', { today: '2026-11-20' })).toEqual({ ok: false, code: 'AUTOGIRO_DEBIT_ALREADY_LIVE' })
    expect(mock.payloads('autogiro_files', 'insert')).toEqual([])
  })
})

describe('withdrawDebitFile', () => {
  function withFile(debits: Array<{ id: string; status: string }>, file: unknown = { id: 'file-1', kind: 'debits', direction: 'to_bankgirot' }) {
    return createTableMockSupabase({
      autogiro_files: { data: file },
      autogiro_debits: (chain) => (has(chain, 'update') ? { data: null } : { data: debits }),
    })
  }

  it('cancels the debits Bankgirot has not reported on', async () => {
    const mock = withFile([
      { id: 'deb-1', status: 'sent' },
      { id: 'deb-2', status: 'cancelled' },
    ])
    expect(await withdrawDebitFile(mock.supabase as unknown as SupabaseClient, 'company-1', 'file-1')).toEqual({ ok: true, cancelled: 1 })
    expect(mock.payloads('autogiro_debits', 'update')).toEqual([{ status: 'cancelled', status_text: expect.stringContaining('Återkallad') }])
  })

  it('refuses a file Bankgirot already reported on, and a file that is not a debit file', async () => {
    const reported = withFile([{ id: 'deb-1', status: 'debited' }])
    expect(await withdrawDebitFile(reported.supabase as unknown as SupabaseClient, 'company-1', 'file-1')).toEqual({ ok: false, code: 'AUTOGIRO_FILE_ALREADY_REPORTED' })
    const notDebits = withFile([], { id: 'file-1', kind: 'payment_specification', direction: 'from_bankgirot' })
    expect(await withdrawDebitFile(notDebits.supabase as unknown as SupabaseClient, 'company-1', 'file-1')).toEqual({ ok: false, code: 'AUTOGIRO_FILE_NOT_FOUND' })
  })
})

describe('mandates', () => {
  const mandate = { id: 'man-1', customer_id: 'cust-1', payer_number: '5501', status: 'active', source: 'manual', payer_name: null, status_text: null, status_changed_on: null, created_at: '2026-11-01' }

  function mandateMock(options: { customer?: unknown; activeForCustomer?: unknown; byPayer?: unknown; byId?: unknown } = {}) {
    return createTableMockSupabase({
      autogiro_settings: { data: SETTINGS },
      customers: { data: options.customer === undefined ? { id: 'cust-1' } : options.customer },
      autogiro_mandates: (chain) => {
        if (has(chain, 'insert') || has(chain, 'update')) return { data: { ...mandate, ...(has(chain, 'update') ? { status: 'cancelled' } : {}) } }
        if (arg(chain, 'eq', 'id')) return { data: options.byId === undefined ? mandate : options.byId }
        if (arg(chain, 'eq', 'payer_number')) return { data: options.byPayer ?? null }
        if (arg(chain, 'eq', 'status') === 'active') return { data: options.activeForCustomer ?? null }
        return { data: null }
      },
      autogiro_files: { data: { id: 'file-9' } },
    })
  }

  it('registers an existing mandate on a customer by its payer number', async () => {
    const mock = mandateMock()
    const result = await addExistingMandate(mock.supabase as unknown as SupabaseClient, 'company-1', { customer_id: 'cust-1', payer_number: '0005501' })
    expect(result.ok).toBe(true)
    expect(mock.payloads('autogiro_mandates', 'insert')).toEqual([
      expect.objectContaining({ company_id: 'company-1', payer_number: '5501', source: 'manual', customer_id: 'cust-1', status: 'active' }),
    ])
  })

  it('refuses a bad payer number, another company\'s customer, and a customer who already has one', async () => {
    const client = (m: ReturnType<typeof mandateMock>) => m.supabase as unknown as SupabaseClient
    expect(await addExistingMandate(client(mandateMock()), 'company-1', { customer_id: 'cust-1', payer_number: 'abc' })).toEqual({ ok: false, code: 'AUTOGIRO_PAYER_NUMBER_INVALID' })
    expect(await addExistingMandate(client(mandateMock({ customer: null })), 'company-1', { customer_id: 'cust-x', payer_number: '1' })).toEqual({ ok: false, code: 'AUTOGIRO_CUSTOMER_NOT_FOUND' })
    expect(await addExistingMandate(client(mandateMock({ activeForCustomer: { id: 'man-0' } })), 'company-1', { customer_id: 'cust-1', payer_number: '1' })).toEqual({
      ok: false,
      code: 'AUTOGIRO_CUSTOMER_HAS_MANDATE',
    })
  })

  it('links a payer to a customer unless that customer already has another active mandate', async () => {
    const free = mandateMock()
    expect((await linkMandate(free.supabase as unknown as SupabaseClient, 'company-1', 'man-1', 'cust-2')).ok).toBe(true)
    expect(free.payloads('autogiro_mandates', 'update')).toEqual([{ customer_id: 'cust-2' }])
    const taken = mandateMock({ activeForCustomer: { id: 'man-0' } })
    expect(await linkMandate(taken.supabase as unknown as SupabaseClient, 'company-1', 'man-1', 'cust-2')).toEqual({ ok: false, code: 'AUTOGIRO_CUSTOMER_HAS_MANDATE' })
    const missing = mandateMock({ byId: null })
    expect(await linkMandate(missing.supabase as unknown as SupabaseClient, 'company-1', 'man-x', null)).toEqual({ ok: false, code: 'AUTOGIRO_MANDATE_NOT_FOUND' })
  })

  it('cancels a mandate: the TK03 file for the bank is stored and Accounted stops debiting it', async () => {
    const mock = mandateMock()
    const result = await cancelMandate(mock.supabase as unknown as SupabaseClient, 'company-1', 'user-1', 'man-1', '2026-11-20')
    expect(result).toMatchObject({ ok: true, file: { id: 'file-9', filename: 'autogiro-makulering-5501-2026-11-20.txt' } })
    const stored = mock.payloads('autogiro_files', 'insert')[0] as { content: string; kind: string }
    expect(stored.kind).toBe('mandates')
    expect(stored.content.split('\r\n')[1]).toBe(`03${PAYEE_BG_DIGITS.padStart(10, '0')}${'5501'.padStart(16, '0')}${' '.repeat(52)}`)
    expect(mock.payloads('autogiro_mandates', 'update')).toEqual([expect.objectContaining({ status: 'cancelled', status_changed_on: '2026-11-20' })])
  })
})
