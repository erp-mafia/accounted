import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/lib/bookkeeping/engine', () => ({
  createJournalEntry: vi.fn(),
  findFiscalPeriod: vi.fn(),
}))
vi.mock('@/lib/bookkeeping/settlement-account', () => ({
  resolvePrimaryBankAccount: vi.fn(async () => '1931'),
}))
vi.mock('@/lib/bookkeeping/cancel-orphaned-entry', () => ({
  reverseOrphanedJournalEntry: vi.fn(),
}))
vi.mock('@/lib/core/documents/document-service', () => ({
  linkToJournalEntry: vi.fn(),
}))
// record_invoice_write_off runs as the service role (write-off-rpc.ts): the
// service client answers the writer check from `service.member` and the RPC
// through the test's own rpc mock.
const service = vi.hoisted(() => ({
  rpc: null as unknown as (...args: unknown[]) => unknown,
  member: { role: 'member' } as { role: string } | null,
  memberQueries: [] as unknown[][],
}))
vi.mock('@/lib/supabase/server', () => ({
  createServiceClient: () => {
    const chain: Record<string, unknown> = {}
    for (const m of ['select', 'eq', 'neq']) {
      chain[m] = (...args: unknown[]) => {
        service.memberQueries.push([m, ...args])
        return chain
      }
    }
    chain.maybeSingle = () => Promise.resolve({ data: service.member, error: null })
    return { from: () => chain, rpc: (...args: unknown[]) => service.rpc(...args) }
  },
}))
vi.mock('../state', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../state')>()
  return { ...actual, loadCustomerLossState: vi.fn() }
})

import { createJournalEntry, findFiscalPeriod } from '@/lib/bookkeeping/engine'
import { BookkeepingDatabaseError, TargetPeriodLockedError } from '@/lib/bookkeeping/errors'
import { reverseOrphanedJournalEntry } from '@/lib/bookkeeping/cancel-orphaned-entry'
import { resolvePrimaryBankAccount } from '@/lib/bookkeeping/settlement-account'
import { linkToJournalEntry } from '@/lib/core/documents/document-service'
import { reserveOutstanding } from '../amounts'
import { recordConfirmedLoss } from '../confirmed'
import { recordDoubtfulLoss, releaseDoubtfulReserve } from '../doubtful'
import { decisionId } from '../ids'
import { recordRecoveredLoss } from '../recovered'
import { loadCustomerLossState, type CustomerLossState, type WriteOffRow } from '../state'

const COMPANY = 'company-1'
const USER = 'user-1'
const INVOICE = '11111111-1111-4111-8111-111111111111'

function makeState(overrides: Omit<Partial<CustomerLossState>, 'invoice'> & { invoice?: Partial<CustomerLossState['invoice']> } = {}): CustomerLossState {
  const rows = overrides.rows ?? []
  const base: CustomerLossState = {
    invoice: {
      id: INVOICE,
      invoice_number: '1042',
      status: 'overdue',
      currency: 'SEK',
      total: 1250,
      paid_amount: 0,
      remaining_amount: 1250,
      due_date: '2026-02-14',
      journal_entry_id: 'je-invoice',
      deduction_total: 0,
      document_type: 'invoice',
      credited_invoice_id: null,
    },
    accountingMethod: 'accrual',
    booked: true,
    receivableAccount: '1510',
    openVat: new Map([['2611', 250]]),
    basis: 1250,
    rows,
    reserve: reserveOutstanding(rows),
    confirmed: null,
    latestCase: null,
  }
  const { invoice, ...rest } = overrides
  return { ...base, ...rest, invoice: { ...base.invoice, ...(invoice ?? {}) } }
}

function mockSupabase(opts: { rpcError?: { message: string; code?: string }; evidence?: { id: string; journal_entry_id: string | null } | null } = {}) {
  const rpc = vi.fn().mockResolvedValue(
    opts.rpcError ? { data: null, error: opts.rpcError } : { data: { invoice_status: 'written_off' }, error: null },
  )
  const evidence = opts.evidence === undefined ? { id: 'doc-1', journal_entry_id: null } : opts.evidence
  const chain = {
    select: () => chain,
    eq: () => chain,
    maybeSingle: () => Promise.resolve({ data: evidence, error: null }),
  }
  service.rpc = rpc
  // The person's own client never calls the function: it is the service role's.
  const sessionRpc = vi.fn().mockResolvedValue({ data: null, error: { message: 'permission denied for function record_invoice_write_off' } })
  const supabase = { rpc: sessionRpc, from: vi.fn(() => chain) } as unknown as SupabaseClient
  return { supabase, rpc, sessionRpc }
}

const lineTuples = () =>
  vi.mocked(createJournalEntry).mock.calls[0]![3].lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(findFiscalPeriod).mockResolvedValue('fp-1')
  vi.mocked(createJournalEntry).mockResolvedValue({ id: 'je-loss' } as never)
  service.member = { role: 'member' }
  service.memberQueries = []
})

describe('who records a decision', () => {
  it('records it as the service role for the acting person, a writer in the company', async () => {
    vi.mocked(loadCustomerLossState).mockResolvedValue({ ok: true, state: makeState() })
    const { supabase, rpc, sessionRpc } = mockSupabase()
    const outcome = await recordDoubtfulLoss(supabase, COMPANY, USER, {
      invoiceId: INVOICE,
      entryDate: '2026-06-01',
      reason: 'Kunden svarar inte',
      decidedBy: USER,
    })
    expect(outcome.ok).toBe(true)
    expect(rpc).toHaveBeenCalledWith('record_invoice_write_off', expect.objectContaining({ p_company_id: COMPANY, p_decided_by: USER }))
    expect(sessionRpc).not.toHaveBeenCalled()
    // The function's own rule for a signed-in caller: a member, not a viewer.
    expect(service.memberQueries).toEqual(
      expect.arrayContaining([
        ['eq', 'company_id', COMPANY],
        ['eq', 'user_id', USER],
        ['neq', 'role', 'viewer'],
      ]),
    )
  })

  it('refuses a person who is not a writer in the company before anything is booked', async () => {
    vi.mocked(loadCustomerLossState).mockResolvedValue({ ok: true, state: makeState() })
    service.member = null
    const { supabase, rpc, sessionRpc } = mockSupabase()
    const outcome = await recordDoubtfulLoss(supabase, COMPANY, USER, {
      invoiceId: INVOICE,
      entryDate: '2026-06-01',
      reason: 'Kunden svarar inte',
      decidedBy: USER,
    })
    expect(outcome).toEqual({ ok: false, code: 'CUSTOMER_LOSS_FORBIDDEN' })
    expect(vi.mocked(createJournalEntry)).not.toHaveBeenCalled()
    expect(rpc).not.toHaveBeenCalled()
    expect(sessionRpc).not.toHaveBeenCalled()
  })
})

describe('befarad kundförlust', () => {
  it('books the open part net of VAT on 6352 / 1519 and records the decision', async () => {
    vi.mocked(loadCustomerLossState).mockResolvedValue({ ok: true, state: makeState() })
    const { supabase, rpc } = mockSupabase()
    const outcome = await recordDoubtfulLoss(supabase, COMPANY, USER, {
      invoiceId: INVOICE,
      entryDate: '2026-06-01',
      reason: 'Kunden svarar inte',
      decidedBy: USER,
    })
    expect(outcome.ok).toBe(true)
    expect(lineTuples()).toEqual([
      ['6352', 1000, 0],
      ['1519', 0, 1000],
    ])
    const input = vi.mocked(createJournalEntry).mock.calls[0]![3]
    expect(input.source_type).toBe('customer_loss')
    expect(input.source_id).toBe(await decisionId(INVOICE, 'doubtful', 0))
    expect(input.description).toBe('Befarad kundförlust faktura 1042 (Kunden svarar inte)')
    expect(rpc).toHaveBeenCalledWith(
      'record_invoice_write_off',
      expect.objectContaining({ p_kind: 'doubtful', p_amount: 1250, p_net_amount: 1000, p_vat_amount: 250, p_journal_entry_id: 'je-loss' }),
    )
  })

  it('books nothing for an invoice that never reached the ledger (kontantmetoden)', async () => {
    vi.mocked(loadCustomerLossState).mockResolvedValue({
      ok: true,
      state: makeState({ accountingMethod: 'cash', booked: false, openVat: new Map(), basis: 0 }),
    })
    const { supabase } = mockSupabase()
    const outcome = await recordDoubtfulLoss(supabase, COMPANY, USER, {
      invoiceId: INVOICE,
      entryDate: '2026-06-01',
      reason: 'x',
      decidedBy: USER,
    })
    expect(outcome).toEqual({ ok: false, code: 'CUSTOMER_LOSS_DOUBTFUL_NOT_BOOKED' })
    expect(createJournalEntry).not.toHaveBeenCalled()
  })

  it('refuses a second reserve for the same open part', async () => {
    const rows = [{ id: 'f', kind: 'doubtful', net_amount: 1000 } as unknown as WriteOffRow]
    vi.mocked(loadCustomerLossState).mockResolvedValue({ ok: true, state: makeState({ rows }) })
    const { supabase } = mockSupabase()
    const outcome = await recordDoubtfulLoss(supabase, COMPANY, USER, { invoiceId: INVOICE, entryDate: '2026-06-01', reason: 'x', decidedBy: USER })
    expect(outcome).toMatchObject({ ok: false, code: 'CUSTOMER_LOSS_ALREADY_RESERVED' })
  })

  it.each([
    [{ invoice: { currency: 'EUR' } }, 'CUSTOMER_LOSS_CURRENCY_UNSUPPORTED'],
    [{ invoice: { deduction_total: 500 } }, 'CUSTOMER_LOSS_DEDUCTION_UNSUPPORTED'],
    [{ invoice: { status: 'paid' } }, 'CUSTOMER_LOSS_INVOICE_NOT_OPEN'],
    [{ invoice: { remaining_amount: 1000 } }, 'CUSTOMER_LOSS_LEDGER_MISMATCH'],
    [{ booked: false, openVat: new Map(), basis: 0 }, 'CUSTOMER_LOSS_INVOICE_NOT_BOOKED'],
  ] as const)('refuses %o with %s', async (overrides, code) => {
    vi.mocked(loadCustomerLossState).mockResolvedValue({ ok: true, state: makeState(overrides as never) })
    const { supabase } = mockSupabase()
    const outcome = await recordDoubtfulLoss(supabase, COMPANY, USER, { invoiceId: INVOICE, entryDate: '2026-06-01', reason: 'x', decidedBy: USER })
    expect(outcome).toMatchObject({ ok: false, code })
    expect(createJournalEntry).not.toHaveBeenCalled()
  })
})

/**
 * 999,75 kr (799,80 + 199,95 moms) whose issue verifikat booked the
 * öresavrundning: D 1510 1 000, K 3740 0,25. 151x carries 1 000, the invoice
 * says 999,75 is left: no mismatch, and every decision values the 1 000.
 */
const roundedIssue = (over: { paid_amount?: number; remaining_amount?: number; status?: string } = {}, rows: WriteOffRow[] = []) =>
  makeState({
    rows,
    basis: 1000,
    openVat: new Map([['2611', 199.95]]),
    invoice: { total: 999.75, paid_amount: 0, remaining_amount: 999.75, ...over },
  })

describe('an invoice whose issue verifikat booked the öresavrundning', () => {
  const params = { invoiceId: INVOICE, entryDate: '2026-06-01', reason: 'Konkurs', evidenceDocumentId: 'doc-1', decidedBy: USER }

  it('writes off all 1510 carries for it: no öre is left on the receivable', async () => {
    vi.mocked(loadCustomerLossState).mockResolvedValue({ ok: true, state: roundedIssue() })
    const { supabase, rpc } = mockSupabase()
    const outcome = await recordConfirmedLoss(supabase, COMPANY, USER, params)
    expect(outcome).toMatchObject({ ok: true })
    expect(lineTuples()).toEqual([
      ['6351', 800.05, 0],
      ['2611', 199.95, 0],
      ['1510', 0, 1000],
    ])
    expect(rpc).toHaveBeenCalledWith(
      'record_invoice_write_off',
      expect.objectContaining({ p_kind: 'confirmed', p_amount: 1000, p_net_amount: 800.05, p_vat_amount: 199.95 }),
    )
  })

  it('reserves the same 1 000 net of VAT, and releases by it after a payment of 500', async () => {
    vi.mocked(loadCustomerLossState).mockResolvedValue({ ok: true, state: roundedIssue() })
    const first = mockSupabase()
    expect(await recordDoubtfulLoss(first.supabase, COMPANY, USER, { invoiceId: INVOICE, entryDate: '2026-06-01', reason: 'x', decidedBy: USER })).toMatchObject({ ok: true })
    expect(lineTuples()).toEqual([
      ['6352', 800.05, 0],
      ['1519', 0, 800.05],
    ])

    vi.clearAllMocks()
    vi.mocked(findFiscalPeriod).mockResolvedValue('fp-1')
    vi.mocked(createJournalEntry).mockResolvedValue({ id: 'je-loss' } as never)
    const reserved = [{ id: 'f', kind: 'doubtful', net_amount: 800.05 } as unknown as WriteOffRow]
    vi.mocked(loadCustomerLossState).mockResolvedValue({
      ok: true,
      state: roundedIssue({ status: 'partially_paid', paid_amount: 500, remaining_amount: 499.75 }, reserved),
    })
    const second = mockSupabase()
    await releaseDoubtfulReserve(second.supabase, COMPANY, USER, { invoiceId: INVOICE, entryDate: '2026-06-05', decidedBy: USER, reason: 'Betalning' })
    // 500 still on 1510: its reserve is 500 less half the VAT (99,98), 400,02.
    expect(lineTuples()).toEqual([
      ['1519', 400.03, 0],
      ['6352', 0, 400.03],
    ])
  })
})

describe('release of a befarad reserve', () => {
  const reserved = [{ id: 'f', kind: 'doubtful', net_amount: 1000 } as unknown as WriteOffRow]

  it('releases pro rata after a partial payment', async () => {
    vi.mocked(loadCustomerLossState).mockResolvedValue({
      ok: true,
      state: makeState({ rows: reserved, invoice: { status: 'partially_paid', paid_amount: 625, remaining_amount: 625 } }),
    })
    const { supabase, rpc } = mockSupabase()
    const outcome = await releaseDoubtfulReserve(supabase, COMPANY, USER, {
      invoiceId: INVOICE,
      entryDate: '2026-06-05',
      decidedBy: USER,
      reason: 'Betalning',
    })
    expect(outcome?.ok).toBe(true)
    expect(lineTuples()).toEqual([
      ['1519', 500, 0],
      ['6352', 0, 500],
    ])
    expect(rpc).toHaveBeenCalledWith('record_invoice_write_off', expect.objectContaining({ p_kind: 'reversed_doubtful', p_net_amount: 500 }))
  })

  it('releases the whole reserve once the invoice is paid or credited', async () => {
    for (const status of ['paid', 'credited']) {
      vi.clearAllMocks()
      vi.mocked(findFiscalPeriod).mockResolvedValue('fp-1')
      vi.mocked(createJournalEntry).mockResolvedValue({ id: 'je-loss' } as never)
      vi.mocked(loadCustomerLossState).mockResolvedValue({
        ok: true,
        state: makeState({ rows: reserved, invoice: { status, remaining_amount: 0, paid_amount: status === 'paid' ? 1250 : 0 } }),
      })
      const { supabase } = mockSupabase()
      await releaseDoubtfulReserve(supabase, COMPANY, USER, { invoiceId: INVOICE, entryDate: '2026-06-05', decidedBy: USER, reason: 'x' })
      expect(lineTuples()).toEqual([
        ['1519', 1000, 0],
        ['6352', 0, 1000],
      ])
    }
  })

  it('does nothing without a reserve', async () => {
    vi.mocked(loadCustomerLossState).mockResolvedValue({ ok: true, state: makeState({ invoice: { status: 'paid', remaining_amount: 0 } }) })
    const { supabase } = mockSupabase()
    expect(await releaseDoubtfulReserve(supabase, COMPANY, USER, { invoiceId: INVOICE, entryDate: '2026-06-05', decidedBy: USER, reason: 'x' })).toBeNull()
    expect(createJournalEntry).not.toHaveBeenCalled()
  })
})

describe('konstaterad kundförlust', () => {
  const params = { invoiceId: INVOICE, entryDate: '2026-06-01', reason: 'Konkurs', evidenceDocumentId: 'doc-1', decidedBy: USER }

  it('needs evidence', async () => {
    const { supabase } = mockSupabase()
    expect(await recordConfirmedLoss(supabase, COMPANY, USER, { ...params, evidenceDocumentId: null })).toEqual({
      ok: false,
      code: 'CUSTOMER_LOSS_EVIDENCE_REQUIRED',
    })
    const missing = mockSupabase({ evidence: null })
    expect(await recordConfirmedLoss(missing.supabase, COMPANY, USER, params)).toEqual({
      ok: false,
      code: 'CUSTOMER_LOSS_EVIDENCE_NOT_FOUND',
    })
  })

  it('reverses the open VAT, clears 1510, releases the reserve and links the evidence', async () => {
    const rows = [{ id: 'f', kind: 'doubtful', net_amount: 500 } as unknown as WriteOffRow]
    vi.mocked(loadCustomerLossState).mockResolvedValue({
      ok: true,
      state: makeState({ rows, invoice: { status: 'partially_paid', paid_amount: 625, remaining_amount: 625 } }),
    })
    const { supabase, rpc } = mockSupabase()
    const outcome = await recordConfirmedLoss(supabase, COMPANY, USER, params)
    expect(outcome).toMatchObject({ ok: true, invoiceStatus: 'written_off', journalEntryId: 'je-loss' })
    expect(lineTuples()).toEqual([
      ['6351', 500, 0],
      ['2611', 125, 0],
      ['1510', 0, 625],
      ['1519', 500, 0],
      ['6352', 0, 500],
    ])
    expect(rpc).toHaveBeenCalledWith(
      'record_invoice_write_off',
      expect.objectContaining({
        p_kind: 'confirmed',
        p_amount: 625,
        p_net_amount: 500,
        p_vat_amount: 125,
        p_reserve_released: 500,
        p_evidence_document_id: 'doc-1',
        p_vat_by_rate: [{ account: '2611', rate: 25, vat: 125, base: 500 }],
      }),
    )
    expect(linkToJournalEntry).toHaveBeenCalledWith(supabase, COMPANY, 'doc-1', 'je-loss', expect.objectContaining({ link_basis: 'user_created' }))
  })

  it('records the decision without a voucher for a never-booked kontantmetod invoice', async () => {
    vi.mocked(loadCustomerLossState).mockResolvedValue({
      ok: true,
      state: makeState({ accountingMethod: 'cash', booked: false, openVat: new Map(), basis: 0 }),
    })
    const { supabase, rpc } = mockSupabase()
    const outcome = await recordConfirmedLoss(supabase, COMPANY, USER, params)
    expect(outcome).toMatchObject({ ok: true, journalEntryId: null })
    expect(createJournalEntry).not.toHaveBeenCalled()
    expect(rpc).toHaveBeenCalledWith(
      'record_invoice_write_off',
      expect.objectContaining({ p_journal_entry_id: null, p_amount: 1250, p_net_amount: 1250, p_vat_amount: 0 }),
    )
    expect(linkToJournalEntry).not.toHaveBeenCalled()
  })

  it('answers a concurrent click with CUSTOMER_LOSS_RACE', async () => {
    vi.mocked(loadCustomerLossState).mockResolvedValue({ ok: true, state: makeState() })
    vi.mocked(createJournalEntry).mockRejectedValue(new BookkeepingDatabaseError('create_draft_entry', 'duplicate key', '23505'))
    const { supabase, rpc } = mockSupabase()
    expect(await recordConfirmedLoss(supabase, COMPANY, USER, params)).toEqual({ ok: false, code: 'CUSTOMER_LOSS_RACE' })
    expect(rpc).not.toHaveBeenCalled()
  })

  it('lets a locked period refuse the whole decision', async () => {
    vi.mocked(loadCustomerLossState).mockResolvedValue({ ok: true, state: makeState() })
    vi.mocked(createJournalEntry).mockRejectedValue(new TargetPeriodLockedError('2026-06-01', '2026-06-30'))
    const { supabase, rpc } = mockSupabase()
    await expect(recordConfirmedLoss(supabase, COMPANY, USER, params)).rejects.toBeInstanceOf(TargetPeriodLockedError)
    expect(rpc).not.toHaveBeenCalled()
  })

  it('stornos the voucher when the decision cannot be recorded', async () => {
    vi.mocked(loadCustomerLossState).mockResolvedValue({ ok: true, state: makeState() })
    const { supabase } = mockSupabase({ rpcError: { message: 'boom', code: 'XX000' } })
    expect(await recordConfirmedLoss(supabase, COMPANY, USER, params)).toMatchObject({ ok: false, code: 'CUSTOMER_LOSS_RECORD_FAILED' })
    expect(reverseOrphanedJournalEntry).toHaveBeenCalledWith(supabase, COMPANY, USER, 'je-loss', expect.any(String))
  })
})

describe('återvunnen kundförlust', () => {
  const confirmed = {
    id: 'g',
    kind: 'confirmed',
    amount: 625,
    net_amount: 500,
    vat_amount: 125,
    vat_by_rate: [{ account: '2611', rate: 25, vat: 125, base: 500 }],
    reserve_released: 0,
    journal_entry_id: 'je-g',
    reverses_id: null,
    decided_at: '2026-06-01T00:00:00Z',
  } as unknown as WriteOffRow
  const params = { invoiceId: INVOICE, amount: 125, entryDate: '2026-07-01', paymentAccount: '1930', reason: 'Utdelning i konkursen', decidedBy: USER }

  it('books the payment on 3950 and reports the VAT again', async () => {
    vi.mocked(loadCustomerLossState).mockResolvedValue({
      ok: true,
      state: makeState({ rows: [confirmed], confirmed, invoice: { status: 'written_off' } }),
    })
    const { supabase, rpc } = mockSupabase()
    const outcome = await recordRecoveredLoss(supabase, COMPANY, USER, params)
    expect(outcome.ok).toBe(true)
    expect(lineTuples()).toEqual([
      ['1930', 125, 0],
      ['3950', 0, 100],
      ['2611', 0, 25],
    ])
    expect(rpc).toHaveBeenCalledWith('record_invoice_write_off', expect.objectContaining({ p_kind: 'recovered', p_net_amount: 100, p_vat_amount: 25 }))
  })

  it('with no account named the money lands on the primary bank account', async () => {
    vi.mocked(loadCustomerLossState).mockResolvedValue({
      ok: true,
      state: makeState({ rows: [confirmed], confirmed, invoice: { status: 'written_off' } }),
    })
    const { supabase } = mockSupabase()
    const { paymentAccount: _named, ...unnamed } = params
    const outcome = await recordRecoveredLoss(supabase, COMPANY, USER, unnamed)
    expect(outcome.ok).toBe(true)
    expect(resolvePrimaryBankAccount).toHaveBeenCalledWith(supabase, COMPANY, expect.anything())
    expect(lineTuples()[0]).toEqual(['1931', 125, 0])
  })

  it('refuses more than was written off, an open invoice and a never-booked write-off', async () => {
    vi.mocked(loadCustomerLossState).mockResolvedValue({
      ok: true,
      state: makeState({ rows: [confirmed], confirmed, invoice: { status: 'written_off' } }),
    })
    const { supabase } = mockSupabase()
    expect(await recordRecoveredLoss(supabase, COMPANY, USER, { ...params, amount: 625.01 })).toMatchObject({
      ok: false,
      code: 'CUSTOMER_LOSS_RECOVERY_EXCEEDS',
    })
    vi.mocked(loadCustomerLossState).mockResolvedValue({ ok: true, state: makeState() })
    expect(await recordRecoveredLoss(supabase, COMPANY, USER, params)).toEqual({ ok: false, code: 'CUSTOMER_LOSS_NOT_WRITTEN_OFF' })
    const unbooked = { ...confirmed, journal_entry_id: null } as WriteOffRow
    vi.mocked(loadCustomerLossState).mockResolvedValue({
      ok: true,
      state: makeState({ rows: [unbooked], confirmed: unbooked, invoice: { status: 'written_off' } }),
    })
    expect(await recordRecoveredLoss(supabase, COMPANY, USER, params)).toEqual({ ok: false, code: 'CUSTOMER_LOSS_RECOVERY_NOT_BOOKED' })
    expect(createJournalEntry).not.toHaveBeenCalled()
  })

  it('refuses a direct payment while the collection case is open, and books one the agency collected', async () => {
    const openCase = { id: 'case-1', stage: 'collection', close_reason: null, is_open: true }
    vi.mocked(loadCustomerLossState).mockResolvedValue({
      ok: true,
      state: makeState({ rows: [confirmed], confirmed, invoice: { status: 'written_off' }, latestCase: openCase }),
    })
    const { supabase } = mockSupabase()
    // The agency must hear of a payment straight to the company first.
    expect(await recordRecoveredLoss(supabase, COMPANY, USER, params)).toEqual({ ok: false, code: 'CUSTOMER_LOSS_RECOVERY_CASE_OPEN' })
    expect(createJournalEntry).not.toHaveBeenCalled()
    // Money the agency collected and reported is booked with the case open.
    const outcome = await recordRecoveredLoss(supabase, COMPANY, USER, { ...params, paymentAccount: '1689', fromCollectedPayment: true })
    expect(outcome.ok).toBe(true)
    expect(lineTuples()[0]).toEqual(['1689', 125, 0])
  })
})
