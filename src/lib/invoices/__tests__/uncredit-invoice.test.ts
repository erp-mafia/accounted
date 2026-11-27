/**
 * Ångra kreditering of a customer invoice (lib/invoices/uncredit-invoice.ts).
 *
 * Pins the rule: a credit is undone only while its credit note never reached
 * the customer (an email the app sent refuses it, a manual mark needs the
 * person's word), the credit note's standing verifikat is stornoed (none when
 * it already was), the credit note is kept as cancelled with
 * credit_undone_at, the original gets its status back from what is paid,
 * and nothing is written before every refusal has had its say.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase, type TableMockResolver } from '@/tests/helpers'
import { eventBus } from '@/lib/events'
import { EntryAlreadyReversedError, TargetPeriodLockedError } from '@/lib/bookkeeping/errors'
import type { Logger } from '@/lib/logger'

const mocks = vi.hoisted(() => ({
  reverseJournalEntry: vi.fn(),
  liveEntryOf: vi.fn(),
  checkPeriodLock: vi.fn(),
}))

vi.mock('@/lib/posting/port', () => ({ postingPort: { reverseJournalEntry: mocks.reverseJournalEntry } }))
vi.mock('@/lib/core/bookkeeping/correction-chain', () => ({ liveEntryOf: mocks.liveEntryOf }))
vi.mock('@/lib/api/v1/check-period-lock', () => ({ checkPeriodLock: mocks.checkPeriodLock }))

import { creditNoteDelivery, invoiceStatusAfterUncredit, uncreditInvoice } from '../uncredit-invoice'

const log: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => log }

const COMPANY_ID = 'company-1'
const USER_ID = 'user-1'
const ORIGINAL_ID = 'original-1'
const CREDIT_ID = 'credit-1'

const ORIGINAL = {
  id: ORIGINAL_ID,
  company_id: COMPANY_ID,
  invoice_number: '1042',
  status: 'credited',
  document_type: 'invoice',
  credited_invoice_id: null,
  total: 12500,
  paid_amount: 12500,
  remaining_amount: 0,
  deduction_total: 0,
  deduction_reclaimed_total: 0,
  due_date: '2026-10-01',
  journal_entry_id: 'je-original',
}

const CREDIT_NOTE = {
  id: CREDIT_ID,
  invoice_number: 'KR-1042',
  status: 'sent',
  journal_entry_id: 'je-credit',
  paid_amount: 0,
  creation_complete: true,
}

const MARKED_SENT = [{ channel: 'manual', status: 'marked_sent' }]

interface Setup {
  original?: Record<string, unknown> | null
  creditNotes?: Record<string, unknown>[]
  deliveries?: Record<string, unknown>[]
  deliveriesError?: unknown
  forwarded?: boolean
  schedules?: boolean
  decisions?: boolean
}

/** The invoices table read by shape: the original by id, its credit notes, and the two writes. */
function setup(opts: Setup = {}) {
  const original = opts.original === undefined ? ORIGINAL : opts.original
  const invoices: TableMockResolver = (chain) => {
    const update = chain.find((c) => c.method === 'update')
    if (update) {
      const payload = update.args[0] as Record<string, unknown>
      if (payload.status === 'cancelled') return { data: [{ id: CREDIT_ID }] }
      return { data: [{ ...original, ...payload }] }
    }
    if (chain.some((c) => c.method === 'eq' && c.args[0] === 'credited_invoice_id')) {
      return { data: opts.creditNotes ?? [CREDIT_NOTE] }
    }
    return { data: original }
  }
  return createTableMockSupabase({
    invoices,
    'rpc:list_invoice_delivery_summaries': opts.deliveriesError
      ? { error: opts.deliveriesError }
      : { data: opts.deliveries ?? [] },
    collection_payment_forwards: { data: opts.forwarded ? [{ id: 'forward-1' }] : [] },
    accrual_schedules: { data: opts.schedules ? [{ id: 'schedule-1' }] : [] },
    invoice_write_offs: { data: opts.decisions ? [{ id: 'decision-1' }] : [] },
    journal_entries: { data: { entry_date: '2026-11-06', voucher_series: 'B', voucher_number: 2 } },
  })
}

const ctx = (supabase: unknown) => ({ supabase: supabase as never, companyId: COMPANY_ID, userId: USER_ID, log })

const invoiceUpdates = (payloads: (table: string, method: string) => unknown[]) =>
  payloads('invoices', 'update') as Record<string, unknown>[]

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
  mocks.liveEntryOf.mockResolvedValue({ id: 'je-credit' })
  mocks.reverseJournalEntry.mockResolvedValue({ id: 'je-storno' })
  mocks.checkPeriodLock.mockResolvedValue({ locked: false, fiscal_period_id: 'fp-1' })
})

describe('creditNoteDelivery', () => {
  it('reads an email the app sent, or is sending, as delivered whatever the provider said later', () => {
    expect(creditNoteDelivery([{ channel: 'email', status: 'sent' }], false)).toBe('delivered')
    expect(creditNoteDelivery([{ channel: 'email', status: 'pending' }], false)).toBe('delivered')
  })

  it('reads a send that failed as no delivery', () => {
    expect(creditNoteDelivery([{ channel: 'email', status: 'failed' }], false)).toBe('none')
    expect(creditNoteDelivery([], false)).toBe('none')
  })

  it('reads a manual mark and an imported copy as marked sent: only the person knows', () => {
    expect(creditNoteDelivery(MARKED_SENT, false)).toBe('marked_sent')
    expect(creditNoteDelivery([{ channel: 'import', status: 'sent' }], false)).toBe('marked_sent')
  })

  it('reads a credit note forwarded to the collection provider as delivered', () => {
    expect(creditNoteDelivery([], true)).toBe('delivered')
  })

  it('lets an email win over a manual mark', () => {
    expect(creditNoteDelivery([...MARKED_SENT, { channel: 'email', status: 'sent' }], false)).toBe('delivered')
  })
})

describe('invoiceStatusAfterUncredit', () => {
  it('gives a paid invoice back its paid status and nothing left to pay', () => {
    expect(invoiceStatusAfterUncredit({ total: 12500, paid_amount: 12500 })).toEqual({ status: 'paid', remaining_amount: 0 })
  })

  it('gives an unpaid invoice back sent and its whole amount', () => {
    expect(invoiceStatusAfterUncredit({ total: 12500, paid_amount: 0 })).toEqual({ status: 'sent', remaining_amount: 12500 })
  })

  it('reads a part payment as partly paid', () => {
    expect(invoiceStatusAfterUncredit({ total: 12500, paid_amount: 2500 })).toEqual({
      status: 'partially_paid',
      remaining_amount: 10000,
    })
  })

  it('measures a ROT invoice against the customer share, not the gross total', () => {
    expect(invoiceStatusAfterUncredit({ total: 12500, paid_amount: 8750, deduction_total: 3750 })).toEqual({
      status: 'paid',
      remaining_amount: 0,
    })
    expect(invoiceStatusAfterUncredit({ total: 12500, paid_amount: 0, deduction_total: 3750 })).toEqual({
      status: 'sent',
      remaining_amount: 8750,
    })
  })
})

describe('uncreditInvoice', () => {
  it('answers INVOICE_NOT_FOUND for an unknown invoice', async () => {
    const { supabase } = setup({ original: null })
    const result = await uncreditInvoice(ctx(supabase), ORIGINAL_ID)
    expect(result).toEqual({ ok: false, code: 'INVOICE_NOT_FOUND' })
  })

  it('changes nothing on an invoice that is not credited, a credit note among them', async () => {
    for (const original of [
      { ...ORIGINAL, status: 'paid' },
      { ...ORIGINAL, id: CREDIT_ID, status: 'sent', credited_invoice_id: ORIGINAL_ID, total: -12500 },
    ]) {
      const { supabase, payloads } = setup({ original })
      const result = await uncreditInvoice(ctx(supabase), original.id)
      expect(result).toMatchObject({ ok: true, data: { changed: false, reversal_entry_id: null } })
      expect(invoiceUpdates(payloads)).toEqual([])
    }
    expect(mocks.reverseJournalEntry).not.toHaveBeenCalled()
  })

  it('refuses a credit note the app emailed to the customer, and offers the copy', async () => {
    const { supabase, payloads } = setup({ deliveries: [{ channel: 'email', status: 'sent' }] })
    const result = await uncreditInvoice(ctx(supabase), ORIGINAL_ID, { attestNotDelivered: true })
    expect(result).toEqual({
      ok: false,
      code: 'INVOICE_UNCREDIT_DELIVERED',
      details: { credit_note_id: CREDIT_ID, credit_note_number: 'KR-1042', copy_from_invoice_id: ORIGINAL_ID },
    })
    expect(mocks.reverseJournalEntry).not.toHaveBeenCalled()
    expect(invoiceUpdates(payloads)).toEqual([])
  })

  it('refuses a credit note forwarded to the collection provider', async () => {
    const { supabase } = setup({ forwarded: true })
    const result = await uncreditInvoice(ctx(supabase), ORIGINAL_ID)
    expect(result).toMatchObject({ ok: false, code: 'INVOICE_UNCREDIT_DELIVERED' })
  })

  it('needs the attestation for a credit note marked as sent, and writes nothing without it', async () => {
    const { supabase, payloads } = setup({ deliveries: MARKED_SENT })
    const result = await uncreditInvoice(ctx(supabase), ORIGINAL_ID)
    expect(result).toMatchObject({ ok: false, code: 'INVOICE_UNCREDIT_ATTESTATION_REQUIRED' })
    expect(mocks.reverseJournalEntry).not.toHaveBeenCalled()
    expect(invoiceUpdates(payloads)).toEqual([])
  })

  it('stornoes the credit verifikat, keeps the credit note as undone and restores the original, on the attestation', async () => {
    const uncredited = vi.fn()
    eventBus.on('invoice.uncredited', uncredited)
    const { supabase, payloads } = setup({ deliveries: MARKED_SENT })

    const result = await uncreditInvoice(ctx(supabase), ORIGINAL_ID, { attestNotDelivered: true })

    expect(result).toMatchObject({
      ok: true,
      data: { changed: true, credit_note_id: CREDIT_ID, reversal_entry_id: 'je-storno', invoice: { status: 'paid' } },
    })
    expect(mocks.reverseJournalEntry).toHaveBeenCalledTimes(1)
    expect(mocks.reverseJournalEntry.mock.calls[0][0]).toMatchObject({
      companyId: COMPANY_ID,
      userId: USER_ID,
      entryId: 'je-credit',
      role: 'reversal',
    })
    // No reversalDate: the storno is dated on the credit verifikat's own date.
    expect(mocks.reverseJournalEntry.mock.calls[0][0].reversalDate).toBeUndefined()
    const [undone, restored] = invoiceUpdates(payloads)
    expect(undone).toMatchObject({ status: 'cancelled', credit_undone_at: expect.any(String) })
    expect(restored).toEqual({ status: 'paid', remaining_amount: 0 })
    expect(uncredited).toHaveBeenCalledWith(
      expect.objectContaining({
        creditNoteId: CREDIT_ID,
        reversalEntryId: 'je-storno',
        deliveryBasis: 'attested_not_delivered',
        userId: USER_ID,
        companyId: COMPANY_ID,
      }),
    )
  })

  it('restores without a storno when the credit verifikat was already stornoed by hand', async () => {
    const uncredited = vi.fn()
    eventBus.on('invoice.uncredited', uncredited)
    mocks.liveEntryOf.mockResolvedValue({ none: true })
    const { supabase, payloads } = setup()

    const result = await uncreditInvoice(ctx(supabase), ORIGINAL_ID)

    expect(result).toMatchObject({ ok: true, data: { changed: true, reversal_entry_id: null } })
    expect(mocks.reverseJournalEntry).not.toHaveBeenCalled()
    expect(invoiceUpdates(payloads)).toEqual([
      expect.objectContaining({ status: 'cancelled' }),
      { status: 'paid', remaining_amount: 0 },
    ])
    expect(uncredited).toHaveBeenCalledWith(
      expect.objectContaining({ reversalEntryId: null, deliveryBasis: 'no_delivery' }),
    )
  })

  it('stornoes the live correction when the credit verifikat was corrected', async () => {
    mocks.liveEntryOf.mockResolvedValue({ id: 'je-correction' })
    const { supabase } = setup()
    await uncreditInvoice(ctx(supabase), ORIGINAL_ID)
    expect(mocks.liveEntryOf).toHaveBeenCalledWith(supabase, COMPANY_ID, 'je-credit')
    expect(mocks.reverseJournalEntry.mock.calls[0][0]).toMatchObject({ entryId: 'je-correction' })
  })

  it('carries on when the verifikat was stornoed between the read and the storno', async () => {
    mocks.reverseJournalEntry.mockRejectedValue(new EntryAlreadyReversedError())
    const { supabase, payloads } = setup()
    const result = await uncreditInvoice(ctx(supabase), ORIGINAL_ID)
    expect(result).toMatchObject({ ok: true, data: { changed: true, reversal_entry_id: null } })
    expect(invoiceUpdates(payloads)).toHaveLength(2)
  })

  it('stops with the engine refusal when the storno is refused, and leaves both rows as they are', async () => {
    const refusal = new TargetPeriodLockedError('2026-11-06', '2026-11-30')
    mocks.reverseJournalEntry.mockRejectedValue(refusal)
    const { supabase, payloads } = setup()
    const result = await uncreditInvoice(ctx(supabase), ORIGINAL_ID)
    expect(result).toMatchObject({ ok: false, error: refusal })
    expect(invoiceUpdates(payloads)).toEqual([])
  })

  it('refuses while a refund of the credit note stands', async () => {
    const { supabase } = setup({ creditNotes: [{ ...CREDIT_NOTE, paid_amount: -12500 }] })
    const result = await uncreditInvoice(ctx(supabase), ORIGINAL_ID)
    expect(result).toMatchObject({ ok: false, code: 'INVOICE_UNCREDIT_REFUNDED' })
    expect(mocks.reverseJournalEntry).not.toHaveBeenCalled()
  })

  it('refuses a credit that ended periodiseringar or touched a kundförlust decision', async () => {
    for (const [opts, reason] of [
      [{ schedules: true }, 'accrual_schedules'],
      [{ decisions: true }, 'customer_loss'],
    ] as const) {
      const { supabase } = setup(opts)
      const result = await uncreditInvoice(ctx(supabase), ORIGINAL_ID)
      expect(result).toMatchObject({ ok: false, code: 'INVOICE_UNCREDIT_NOT_REVERSIBLE', details: { reason } })
    }
    expect(mocks.reverseJournalEntry).not.toHaveBeenCalled()
  })

  it('refuses an original whose credit is not one issued credit note', async () => {
    for (const creditNotes of [[], [CREDIT_NOTE, { ...CREDIT_NOTE, id: 'credit-2' }], [{ ...CREDIT_NOTE, status: 'credited' }]]) {
      const { supabase } = setup({ creditNotes })
      const result = await uncreditInvoice(ctx(supabase), ORIGINAL_ID)
      expect(result).toMatchObject({
        ok: false,
        code: 'INVOICE_UNCREDIT_NOT_REVERSIBLE',
        details: { reason: 'credit_note_state' },
      })
    }
  })

  it('fails closed when the delivery history cannot be read', async () => {
    const { supabase, payloads } = setup({ deliveriesError: { code: '42501', message: 'not authorized' } })
    const result = await uncreditInvoice(ctx(supabase), ORIGINAL_ID)
    expect(result).toMatchObject({ ok: false, code: 'UNKNOWN_ERROR' })
    expect(invoiceUpdates(payloads)).toEqual([])
  })

  it('dry run: says what it would do, the attestation it needs and the storno, and writes nothing', async () => {
    const { supabase, payloads } = setup({ deliveries: MARKED_SENT })
    const result = await uncreditInvoice(ctx(supabase), ORIGINAL_ID, {}, { dryRun: true })
    expect(result).toMatchObject({
      ok: true,
      dryRun: true,
      preview: {
        changed: true,
        credit_note_id: CREDIT_ID,
        credit_note_number: 'KR-1042',
        delivery: 'marked_sent',
        attestation_required: true,
        posts_storno: true,
        credit_voucher: 'B2',
        storno_date: '2026-11-06',
        restored_status: 'paid',
        remaining_amount: 0,
      },
    })
    expect(mocks.checkPeriodLock).toHaveBeenCalledWith(supabase, COMPANY_ID, '2026-11-06')
    expect(mocks.reverseJournalEntry).not.toHaveBeenCalled()
    expect(invoiceUpdates(payloads)).toEqual([])
  })

  it('dry run: refuses a storno the locked period would refuse', async () => {
    mocks.checkPeriodLock.mockResolvedValue({ locked: true, reason: 'period_locked_at_set', fiscal_period_id: 'fp-1' })
    const { supabase } = setup()
    const result = await uncreditInvoice(ctx(supabase), ORIGINAL_ID, {}, { dryRun: true })
    expect(result).toMatchObject({ ok: false, code: 'PERIOD_LOCKED', details: { entry_date: '2026-11-06' } })
  })
})
