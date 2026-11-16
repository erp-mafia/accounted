/**
 * linkCreditNoteToInvoice (crm#1852): an existing credit note linked to the
 * existing invoice it credits. The kundreskontra side of an ordinary credit
 * and nothing else: every pair an ordinary credit would have booked, and
 * every pair that is not one credit of one invoice, is refused before a
 * write.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eventBus } from '@/lib/events'
import { createLogger } from '@/lib/logger'
import { linkCreditNoteToInvoice } from '../link-credit-note'

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const INVOICE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const CREDIT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'
const CUSTOMER_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

type Row = Record<string, unknown>

const ORIGINAL: Row = {
  id: INVOICE_ID,
  company_id: COMPANY_ID,
  customer_id: CUSTOMER_ID,
  invoice_number: '1042',
  document_type: 'invoice',
  status: 'overdue',
  total: 12500,
  paid_amount: 0,
  remaining_amount: 12500,
  paid_at: null,
  currency: 'SEK',
  exchange_rate: null,
  journal_entry_id: null,
  credited_invoice_id: null,
  deduction_total: 0,
}

const CREDIT_NOTE: Row = {
  ...ORIGINAL,
  id: CREDIT_ID,
  invoice_number: '1043',
  status: 'credited',
  total: -12500,
  remaining_amount: 0,
}

interface World {
  invoices: Row[]
  accountingMethod: string | null
  writeOffs: Row[]
  /** Applied to the world just before the given update number (1-based) runs. */
  beforeUpdate?: Record<number, (world: World) => void>
  /** The error the first update answers with. */
  linkError?: { message: string; code?: string }
  readError?: { message: string; code?: string }
}

interface Filter { op: 'eq' | 'neq' | 'is' | 'in'; column: string; value: unknown }

/**
 * A small in-memory `invoices` table that applies the filters the service
 * sends, so a compare-and-set that should miss does miss.
 */
function createWorld(overrides: Partial<World> = {}) {
  const world: World = {
    invoices: [{ ...ORIGINAL }, { ...CREDIT_NOTE }],
    accountingMethod: 'cash',
    writeOffs: [],
    ...overrides,
  }
  const updates: Array<{ table: string; values: Row; filters: Filter[] }> = []

  const matches = (row: Row, filters: Filter[]) =>
    filters.every((f) => {
      const cell = row[f.column] ?? null
      if (f.op === 'eq') return cell === f.value
      if (f.op === 'neq') return cell !== f.value
      if (f.op === 'is') return cell === f.value
      return (f.value as unknown[]).includes(cell)
    })

  const from = (table: string) => {
    const filters: Filter[] = []
    let values: Row | null = null
    let single = false
    let head = false
    const resolveQuery = () => {
      if (table === 'company_settings') {
        return { data: world.accountingMethod ? { accounting_method: world.accountingMethod } : null, error: null }
      }
      if (table === 'invoice_write_offs') return { data: world.writeOffs, error: null }
      if (values) {
        const number = updates.length + 1
        world.beforeUpdate?.[number]?.(world)
        updates.push({ table, values, filters })
        if (number === 1 && world.linkError) return { data: null, error: world.linkError }
        const hit = world.invoices.filter((row) => matches(row, filters))
        for (const row of hit) Object.assign(row, values)
        return { data: single ? (hit[0] ?? null) : hit, error: null }
      }
      if (world.readError) return { data: null, error: world.readError, count: null }
      const hit = world.invoices.filter((row) => matches(row, filters))
      if (head) return { data: null, error: null, count: hit.length }
      return { data: single ? (hit[0] ?? null) : hit, error: null }
    }
    const chain = {
      select: (_columns?: string, options?: { head?: boolean }) => {
        if (options?.head) head = true
        return chain
      },
      update: (next: Row) => {
        values = next
        return chain
      },
      eq: (column: string, value: unknown) => (filters.push({ op: 'eq', column, value }), chain),
      neq: (column: string, value: unknown) => (filters.push({ op: 'neq', column, value }), chain),
      is: (column: string, value: unknown) => (filters.push({ op: 'is', column, value }), chain),
      in: (column: string, value: unknown) => (filters.push({ op: 'in', column, value }), chain),
      limit: () => chain,
      maybeSingle: () => {
        single = true
        return chain
      },
      then: (resolve: (value: unknown) => unknown, reject?: (reason: unknown) => unknown) =>
        Promise.resolve(resolveQuery()).then(resolve, reject),
    }
    return chain
  }

  const run = (dryRun = false) =>
    linkCreditNoteToInvoice({
      supabase: { from } as never,
      companyId: COMPANY_ID,
      userId: 'user-1',
      creditNoteId: CREDIT_ID,
      invoiceId: INVOICE_ID,
      log: createLogger('test'),
      dryRun,
    })
  const row = (id: string) => world.invoices.find((r) => r.id === id)!
  return { world, updates, run, row }
}

/** A world whose original or credit note differs from the linkable pair. */
function withRows(original: Row = {}, creditNote: Row = {}, rest: Partial<World> = {}) {
  return createWorld({ invoices: [{ ...ORIGINAL, ...original }, { ...CREDIT_NOTE, ...creditNote }], ...rest })
}

const created = vi.fn()

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  eventBus.on('credit_note.created', created)
})

describe('linkCreditNoteToInvoice: the link', () => {
  it('links the credit note, moves the original to credited and books nothing', async () => {
    const { run, row, updates } = createWorld()
    const result = await run()

    expect(result).toMatchObject({ ok: true, dryRun: false, creditAmount: 12500, openAmount: 12500, currency: 'SEK' })
    expect(row(CREDIT_ID)).toMatchObject({ credited_invoice_id: INVOICE_ID, status: 'sent' })
    // Nothing is left to pay on the credited original (crm#1886).
    expect(row(INVOICE_ID)).toMatchObject({ status: 'credited', paid_amount: 0, remaining_amount: 0, journal_entry_id: null })
    // Two writes, both on invoices: no journal table is ever touched.
    expect(updates.map((u) => u.table)).toEqual(['invoices', 'invoices'])
    expect(updates[1].values).toEqual({ status: 'credited', remaining_amount: 0 })
  })

  it('writes the link as a compare-and-set on what was read', async () => {
    const { run, updates } = createWorld()
    await run()
    expect(updates[0].filters).toEqual(
      expect.arrayContaining([
        { op: 'eq', column: 'id', value: CREDIT_ID },
        { op: 'eq', column: 'company_id', value: COMPANY_ID },
        { op: 'is', column: 'credited_invoice_id', value: null },
        { op: 'eq', column: 'status', value: 'credited' },
      ]),
    )
    expect(updates[1].filters).toEqual(
      expect.arrayContaining([
        { op: 'eq', column: 'id', value: INVOICE_ID },
        { op: 'eq', column: 'company_id', value: COMPANY_ID },
      ]),
    )
  })

  it('emits credit_note.created with the linked credit note', async () => {
    const { run } = createWorld()
    await run()
    expect(created).toHaveBeenCalledTimes(1)
    expect(created.mock.calls[0][0]).toMatchObject({
      companyId: COMPANY_ID,
      userId: 'user-1',
      creditNote: { id: CREDIT_ID, credited_invoice_id: INVOICE_ID, status: 'sent' },
    })
  })

  it('links a credit note that already rests at sent, and a sent original', async () => {
    const { run, row } = withRows({ status: 'sent' }, { status: 'sent' })
    expect(await run()).toMatchObject({ ok: true })
    expect(row(INVOICE_ID).status).toBe('credited')
  })

  it('a dry run checks everything and writes nothing', async () => {
    const { run, updates, row } = createWorld()
    const result = await run(true)
    expect(result).toMatchObject({ ok: true, dryRun: true, creditAmount: 12500 })
    expect(updates).toEqual([])
    expect(row(INVOICE_ID).status).toBe('overdue')
    expect(created).not.toHaveBeenCalled()
  })
})

describe('linkCreditNoteToInvoice: refusals, none of which writes', () => {
  async function refused(setup: ReturnType<typeof createWorld>) {
    const result = await setup.run()
    expect(setup.updates).toEqual([])
    expect(created).not.toHaveBeenCalled()
    return result
  }

  it('a credit note or an invoice that does not exist in the company', async () => {
    expect(await refused(createWorld({ invoices: [{ ...ORIGINAL }] }))).toEqual({
      ok: false, code: 'INVOICE_NOT_FOUND', details: { missing: 'credit_note' },
    })
    expect(await refused(createWorld({ invoices: [{ ...CREDIT_NOTE }] }))).toEqual({
      ok: false, code: 'INVOICE_NOT_FOUND', details: { missing: 'invoice' },
    })
    expect(await refused(withRows({ company_id: 'another-company' }))).toMatchObject({ code: 'INVOICE_NOT_FOUND' })
  })

  it('a different customer, or no customer', async () => {
    expect(await refused(withRows({}, { customer_id: 'another-customer' }))).toEqual({
      ok: false, code: 'INVOICE_CREDIT_LINK_CUSTOMER_MISMATCH',
    })
    expect(await refused(withRows({ customer_id: null }, { customer_id: null }))).toMatchObject({
      code: 'INVOICE_CREDIT_LINK_CUSTOMER_MISMATCH',
    })
  })

  it('a different currency, and a foreign pair at different rates', async () => {
    expect(await refused(withRows({}, { currency: 'EUR', exchange_rate: 11.2 }))).toEqual({
      ok: false, code: 'INVOICE_CREDIT_LINK_CURRENCY_MISMATCH', details: { reason: 'currency' },
    })
    expect(
      await refused(withRows({ currency: 'EUR', exchange_rate: 11.2 }, { currency: 'EUR', exchange_rate: 11.5 })),
    ).toEqual({ ok: false, code: 'INVOICE_CREDIT_LINK_CURRENCY_MISMATCH', details: { reason: 'exchange_rate' } })
  })

  it('a null currency reads as kronor on both sides', async () => {
    const { run } = withRows({ currency: null }, { currency: 'SEK' })
    expect(await run()).toMatchObject({ ok: true, currency: 'SEK' })
  })

  it('a credit larger than what the invoice asks for', async () => {
    expect(await refused(withRows({}, { total: -12500.01 }))).toEqual({
      ok: false,
      code: 'INVOICE_CREDIT_LINK_AMOUNT_MISMATCH',
      details: { reason: 'exceeds_open_amount', credit_amount: 12500.01, open_amount: 12500 },
    })
  })

  it('a partial credit', async () => {
    expect(await refused(withRows({}, { total: -5000 }))).toEqual({
      ok: false,
      code: 'INVOICE_CREDIT_LINK_AMOUNT_MISMATCH',
      details: { reason: 'partial_credit', credit_amount: 5000, open_amount: 12500 },
    })
  })

  it('a credit note that is already linked, to this invoice or another', async () => {
    expect(await refused(withRows({}, { credited_invoice_id: INVOICE_ID }))).toEqual({
      ok: false,
      code: 'INVOICE_CREDIT_LINK_ALREADY_LINKED',
      details: { credited_invoice_id: INVOICE_ID, same_invoice: true },
    })
    expect(await refused(withRows({}, { credited_invoice_id: 'another-invoice' }))).toMatchObject({
      code: 'INVOICE_CREDIT_LINK_ALREADY_LINKED',
      details: { same_invoice: false },
    })
  })

  it('a document that is not an issued, unused credit note', async () => {
    const code = 'INVOICE_CREDIT_LINK_NOT_A_CREDIT_NOTE'
    expect(await refused(withRows({}, { total: 12500 }))).toEqual({ ok: false, code, details: { reason: 'not_negative' } })
    expect(await refused(withRows({}, { document_type: 'quote' }))).toEqual({ ok: false, code, details: { reason: 'not_an_invoice' } })
    for (const status of ['draft', 'cancelled', 'paid']) {
      expect(await refused(withRows({}, { status }))).toEqual({ ok: false, code, details: { reason: 'status', status } })
    }
    expect(await refused(withRows({}, { paid_amount: -12500 }))).toEqual({ ok: false, code, details: { reason: 'refunded' } })
  })

  it('an original that is not an issued sales invoice still to be credited', async () => {
    const code = 'INVOICE_CREDIT_LINK_ORIGINAL_NOT_OPEN'
    for (const status of ['draft', 'cancelled', 'credited', 'written_off']) {
      expect(await refused(withRows({ status }))).toEqual({ ok: false, code, details: { reason: 'status', status } })
    }
    expect(await refused(withRows({ document_type: 'proforma' }))).toEqual({ ok: false, code, details: { reason: 'not_an_invoice' } })
    expect(await refused(withRows({ total: -100 }))).toEqual({ ok: false, code, details: { reason: 'is_credit_note' } })
  })

  it('an original that already carries a credit note', async () => {
    const sibling = { ...CREDIT_NOTE, id: 'sibling', credited_invoice_id: INVOICE_ID }
    expect(await refused(createWorld({ invoices: [{ ...ORIGINAL }, { ...CREDIT_NOTE }, sibling] }))).toEqual({
      ok: false, code: 'INVOICE_CREDIT_LINK_ORIGINAL_NOT_OPEN', details: { reason: 'has_credit_note' },
    })
    // A cancelled credit note credits nothing.
    const cancelled = createWorld({ invoices: [{ ...ORIGINAL }, { ...CREDIT_NOTE }, { ...sibling, status: 'cancelled' }] })
    expect(await cancelled.run()).toMatchObject({ ok: true })
  })

  describe('a pair an ordinary credit would have booked', () => {
    const code = 'INVOICE_CREDIT_LINK_BOOKING_REQUIRED'

    it('faktureringsmetoden, also when no method is stored', async () => {
      expect(await refused(createWorld({ accountingMethod: 'accrual' }))).toEqual({ ok: false, code, details: { reason: 'accrual_method' } })
      expect(await refused(createWorld({ accountingMethod: null }))).toEqual({ ok: false, code, details: { reason: 'accrual_method' } })
    })

    it('an original with a verifikat or a payment', async () => {
      const paidOrBooked: Row[] = [
        { journal_entry_id: 'entry-1' },
        { status: 'paid', paid_amount: 12500 },
        { status: 'partially_paid', paid_amount: 2500 },
        { paid_at: '2026-01-15T00:00:00Z' },
        { paid_amount: 0.01 },
      ]
      for (const original of paidOrBooked) {
        expect(await refused(withRows(original))).toEqual({ ok: false, code, details: { reason: 'original_paid_or_booked' } })
      }
    })

    it('a credit note with a verifikat', async () => {
      expect(await refused(withRows({}, { journal_entry_id: 'entry-2' }))).toEqual({ ok: false, code, details: { reason: 'credit_note_booked' } })
    })

    it('ROT/RUT on either document', async () => {
      expect(await refused(withRows({ deduction_total: 3000 }))).toEqual({ ok: false, code, details: { reason: 'rot_rut' } })
      expect(await refused(withRows({}, { deduction_total: -3000 }))).toEqual({ ok: false, code, details: { reason: 'rot_rut' } })
    })

    it('an original with a kundförlust decision', async () => {
      expect(await refused(createWorld({ writeOffs: [{ id: 'decision-1' }] }))).toEqual({
        ok: false, code, details: { reason: 'customer_loss_decision' },
      })
    })
  })

  it('a failed read', async () => {
    expect(await refused(createWorld({ readError: { message: 'boom', code: 'XX000' } }))).toEqual({
      ok: false, code: 'DB_ERROR', cause: { message: 'boom', code: 'XX000' },
    })
  })
})

describe('linkCreditNoteToInvoice: races', () => {
  it('a credit note linked by someone else between the read and the write is left as it is', async () => {
    const { run, row, updates } = createWorld({
      beforeUpdate: { 1: (world) => Object.assign(world.invoices[1], { credited_invoice_id: 'another-invoice' }) },
    })
    expect(await run()).toEqual({ ok: false, code: 'INVOICE_CREDIT_LINK_RACE' })
    expect(updates).toHaveLength(1)
    expect(row(CREDIT_ID)).toMatchObject({ credited_invoice_id: 'another-invoice', status: 'credited' })
    expect(row(INVOICE_ID).status).toBe('overdue')
    expect(created).not.toHaveBeenCalled()
  })

  it('an original that changed before its status write gets the link undone', async () => {
    const { run, row, updates } = createWorld({
      beforeUpdate: { 2: (world) => Object.assign(world.invoices[0], { status: 'cancelled' }) },
    })
    expect(await run()).toEqual({ ok: false, code: 'INVOICE_CREDIT_LINK_RACE' })
    expect(updates).toHaveLength(3)
    expect(row(CREDIT_ID)).toMatchObject({ credited_invoice_id: null, status: 'credited' })
    expect(row(INVOICE_ID).status).toBe('cancelled')
    expect(created).not.toHaveBeenCalled()
  })

  it('the credit cap of the schema refusing the pair is an amount refusal', async () => {
    const { run, row } = createWorld({ linkError: { message: 'cap', code: '23514' } })
    expect(await run()).toMatchObject({
      ok: false, code: 'INVOICE_CREDIT_LINK_AMOUNT_MISMATCH', details: { reason: 'credit_cap' },
    })
    expect(row(INVOICE_ID).status).toBe('overdue')
  })
})
