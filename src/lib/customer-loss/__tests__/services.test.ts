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
import { planConfirmed, recordConfirmedLoss } from '../confirmed'
import { recordDoubtfulLoss, releaseDoubtfulReserve } from '../doubtful'
import { decisionId } from '../ids'
import { recordRecoveredLoss } from '../recovered'
import { invoiceToPayRounding, loadCustomerLossState, type CustomerLossState, type WriteOffRow } from '../state'
import { buildCustomerLossView } from '../view'

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
    oreRounding: 0,
    toPayRounding: 0,
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

// An issue verifikat that booked the invoice's öresavrundning: 1510 carries the
// rounded "Att betala" and the öre is on 3740, while the reskontra (total,
// remaining_amount) keeps the exact figure. A decision clears what 1510 carries;
// the VAT it moves is what the same invoice moves when its öre is booked at payment.
describe('an invoice whose issue verifikat booked its öresavrundning', () => {
  const params = { invoiceId: INVOICE, entryDate: '2026-06-01', reason: 'Konkurs', evidenceDocumentId: 'doc-1', decidedBy: USER }
  // 799.80 + 199.95 = 999.75, to pay 1 000: D 1510 1 000 / K 3001 799.80 / K 2611 199.95 / K 3740 0.25.
  const roundedUp = {
    openVat: new Map([['2611', 199.95]]),
    basis: 1000,
    oreRounding: 0.25,
    invoice: { total: 999.75, remaining_amount: 999.75 },
  }
  const partPaid = { ...roundedUp, invoice: { ...roundedUp.invoice, status: 'partially_paid', paid_amount: 500, remaining_amount: 499.75 } }

  it('konstaterad writes off the 1 000 on 1510, not the 999.75 of the reskontra', async () => {
    vi.mocked(loadCustomerLossState).mockResolvedValue({ ok: true, state: makeState(roundedUp) })
    const { supabase, rpc } = mockSupabase()
    const outcome = await recordConfirmedLoss(supabase, COMPANY, USER, params)
    expect(outcome).toMatchObject({ ok: true, amount: 1000 })
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

  it('konstaterad of an invoice rounded down writes off the 1 000 on 1510, not 1 000.40', async () => {
    // 800.32 + 200.08 = 1 000.40, to pay 1 000: D 1510 1 000 / D 3740 0.40.
    vi.mocked(loadCustomerLossState).mockResolvedValue({
      ok: true,
      state: makeState({
        openVat: new Map([['2611', 200.08]]),
        basis: 1000,
        oreRounding: -0.4,
        invoice: { total: 1000.4, remaining_amount: 1000.4 },
      }),
    })
    const { supabase } = mockSupabase()
    expect(await recordConfirmedLoss(supabase, COMPANY, USER, params)).toMatchObject({ ok: true, amount: 1000 })
    expect(lineTuples()).toEqual([
      ['6351', 799.92, 0],
      ['2611', 200.08, 0],
      ['1510', 0, 1000],
    ])
  })

  it('konstaterad after a part payment writes off what 1510 still carries, with the VAT of the reskontra', async () => {
    vi.mocked(loadCustomerLossState).mockResolvedValue({ ok: true, state: makeState(partPaid) })
    const { supabase } = mockSupabase()
    expect(await recordConfirmedLoss(supabase, COMPANY, USER, params)).toMatchObject({ ok: true, amount: 500 })
    // 199.95 x 499.75 / 999.75: the VAT the same invoice gives back when its öre is booked at payment.
    expect(lineTuples()).toEqual([
      ['6351', 400.05, 0],
      ['2611', 99.95, 0],
      ['1510', 0, 500],
    ])
  })

  it('moves the same VAT as the same invoice whose öre is booked at payment', () => {
    const atPayment = makeState({ ...partPaid, basis: 999.75, oreRounding: 0 })
    const atIssue = makeState(partPaid)
    expect(planConfirmed(atIssue).shares).toEqual(planConfirmed(atPayment).shares)
    expect(planConfirmed(atIssue).amount).toBe(500)
    expect(planConfirmed(atPayment).amount).toBe(499.75)
  })

  it('konstaterad after a credit note writes off what 1510 still carries', async () => {
    // A credit note of 100 (80 + 20) on the invoice above: 1510 carries 900, the reskontra 899.75.
    vi.mocked(loadCustomerLossState).mockResolvedValue({
      ok: true,
      state: makeState({ ...roundedUp, openVat: new Map([['2611', 179.95]]), basis: 900, invoice: { total: 999.75, remaining_amount: 899.75 } }),
    })
    const { supabase } = mockSupabase()
    expect(await recordConfirmedLoss(supabase, COMPANY, USER, params)).toMatchObject({ ok: true, amount: 900 })
    expect(lineTuples()).toEqual([
      ['6351', 720.05, 0],
      ['2611', 179.95, 0],
      ['1510', 0, 900],
    ])
  })

  it('befarad reserves the 1 000 on 1510 net of its VAT', async () => {
    vi.mocked(loadCustomerLossState).mockResolvedValue({ ok: true, state: makeState(roundedUp) })
    const { supabase } = mockSupabase()
    const outcome = await recordDoubtfulLoss(supabase, COMPANY, USER, { invoiceId: INVOICE, entryDate: '2026-06-01', reason: 'x', decidedBy: USER })
    expect(outcome.ok).toBe(true)
    expect(lineTuples()).toEqual([
      ['6352', 800.05, 0],
      ['1519', 0, 800.05],
    ])
  })

  it('a part payment releases the reserve down to what 1510 still carries net of VAT', async () => {
    const reserved = [{ id: 'f', kind: 'doubtful', net_amount: 800.05 } as unknown as WriteOffRow]
    vi.mocked(loadCustomerLossState).mockResolvedValue({ ok: true, state: makeState({ ...partPaid, rows: reserved }) })
    const { supabase } = mockSupabase()
    await releaseDoubtfulReserve(supabase, COMPANY, USER, { invoiceId: INVOICE, entryDate: '2026-06-05', decidedBy: USER, reason: 'Betalning' })
    // 500 left on 1510, of which 99.95 VAT: the reserve stays at 400.05.
    expect(lineTuples()).toEqual([
      ['1519', 400, 0],
      ['6352', 0, 400],
    ])
  })

  it('the dialog previews what is booked', () => {
    const view = buildCustomerLossView(makeState(roundedUp), { enabled: true, today: '2026-06-01' })
    expect(view.confirmed).toMatchObject({ available: true, amount: 1000, net: 800.05, vat: 199.95 })
    expect(view.doubtful).toMatchObject({ available: true, reserve: 800.05 })
  })

  it.each([
    ['a gap of a krona or more', { basis: 1001.25 }],
    ['a gap of exactly a krona booked on 3740', { basis: 1000.75, oreRounding: 1 }],
    ['an öre gap with no öre on 3740', { basis: 999.5, oreRounding: 0 }],
    ['an öre gap the 3740 line does not explain', { basis: 999.5 }],
  ])('still refuses %s between 1510 and the reskontra', async (_name, overrides) => {
    vi.mocked(loadCustomerLossState).mockResolvedValue({ ok: true, state: makeState({ ...roundedUp, ...overrides }) })
    const { supabase } = mockSupabase()
    expect(await recordConfirmedLoss(supabase, COMPANY, USER, params)).toEqual({ ok: false, code: 'CUSTOMER_LOSS_LEDGER_MISMATCH' })
    expect(
      await recordDoubtfulLoss(supabase, COMPANY, USER, { invoiceId: INVOICE, entryDate: '2026-06-01', reason: 'x', decidedBy: USER }),
    ).toEqual({ ok: false, code: 'CUSTOMER_LOSS_LEDGER_MISMATCH' })
    expect(createJournalEntry).not.toHaveBeenCalled()
  })

  it('refuses a claim 1510 no longer carries', async () => {
    // Rounded down, paid 1 000 through a linked verifikat: 1510 is cleared, the reskontra still says 0.40.
    vi.mocked(loadCustomerLossState).mockResolvedValue({
      ok: true,
      state: makeState({
        openVat: new Map([['2611', 200.08]]),
        basis: 1000,
        oreRounding: -0.4,
        invoice: { total: 1000.4, status: 'partially_paid', paid_amount: 1000, remaining_amount: 0.4 },
      }),
    })
    const { supabase } = mockSupabase()
    expect(await recordConfirmedLoss(supabase, COMPANY, USER, params)).toEqual({ ok: false, code: 'CUSTOMER_LOSS_LEDGER_MISMATCH' })
    expect(createJournalEntry).not.toHaveBeenCalled()
  })

  describe('rounded down with less than the öre left on 1510', () => {
    // 1 000.40 to pay 1 000, paid 999.95: 1510 carries 0.05, the reskontra 0.45,
    // and the reskontra's VAT (0.09) is more than 1510 carries.
    const almostPaid = {
      openVat: new Map([['2611', 200.08]]),
      basis: 1000,
      oreRounding: -0.4,
      invoice: { total: 1000.4, status: 'partially_paid', paid_amount: 999.95, remaining_amount: 0.45 },
    }

    it('refuses konstaterad and befarad', async () => {
      vi.mocked(loadCustomerLossState).mockResolvedValue({ ok: true, state: makeState(almostPaid) })
      const { supabase } = mockSupabase()
      expect(await recordConfirmedLoss(supabase, COMPANY, USER, params)).toEqual({ ok: false, code: 'CUSTOMER_LOSS_LEDGER_MISMATCH' })
      expect(
        await recordDoubtfulLoss(supabase, COMPANY, USER, { invoiceId: INVOICE, entryDate: '2026-06-01', reason: 'x', decidedBy: USER }),
      ).toEqual({ ok: false, code: 'CUSTOMER_LOSS_LEDGER_MISMATCH' })
      expect(createJournalEntry).not.toHaveBeenCalled()
    })

    it('keeps the reserve on the reskontra figure, never releasing more than 1519 holds', async () => {
      const reserved = [{ id: 'f', kind: 'doubtful', net_amount: 799.92 } as unknown as WriteOffRow]
      vi.mocked(loadCustomerLossState).mockResolvedValue({ ok: true, state: makeState({ ...almostPaid, rows: reserved }) })
      const { supabase } = mockSupabase()
      await releaseDoubtfulReserve(supabase, COMPANY, USER, { invoiceId: INVOICE, entryDate: '2026-06-05', decidedBy: USER, reason: 'Betalning' })
      const [[account, released]] = lineTuples()
      expect(account).toBe('1519')
      // The reskontra's 0.45 net of its 0.09 VAT stays reserved: 799.92 - 0.36.
      expect(released).toBe(799.56)
    })
  })
})

// A recovery of an öre-rounded invoice: the customer, or the agency that was
// handed the printed "Att betala", pays what the invoice asked for, while the
// write-off took off what 151x carried. The difference is the invoice's own
// öresavrundning, so the recovery closes the claim, every written-off VAT öre
// is reported again, and the öre goes to 3740 like any payment's öre.
describe('a recovery of an öre-rounded invoice', () => {
  const params = { invoiceId: INVOICE, entryDate: '2026-07-01', paymentAccount: '1930', reason: 'Utdelning i konkursen', decidedBy: USER }
  const writtenOff = (amount: number, net: number, vat: number) =>
    ({
      id: 'g',
      kind: 'confirmed',
      amount,
      net_amount: net,
      vat_amount: vat,
      vat_by_rate: [{ account: '2611', rate: 25, vat, base: Math.round(vat * 400) / 100 }],
      reserve_released: 0,
      journal_entry_id: 'je-g',
      reverses_id: null,
      decided_at: '2026-06-01T00:00:00Z',
    }) as unknown as WriteOffRow
  const recoveryOf = (amount: number, net: number, vat: number) =>
    ({
      id: 'h',
      kind: 'recovered',
      amount,
      net_amount: net,
      vat_amount: vat,
      vat_by_rate: [{ account: '2611', rate: 25, vat, base: Math.round(vat * 400) / 100 }],
      reserve_released: 0,
      journal_entry_id: 'je-h',
      reverses_id: null,
      decided_at: '2026-06-15T00:00:00Z',
    }) as unknown as WriteOffRow
  const stateOf = (
    confirmed: WriteOffRow,
    extra: Omit<Partial<CustomerLossState>, 'invoice'> & { invoice: Partial<CustomerLossState['invoice']> },
    prior: WriteOffRow[] = [],
  ) =>
    makeState({
      rows: [confirmed, ...prior],
      confirmed,
      ...extra,
      invoice: { ...extra.invoice, status: 'written_off' },
    })

  // 999.75 to pay 1 000, its öre left for the payment: the write-off took 999.75 off 1510.
  const roundedUp = stateOf(writtenOff(999.75, 799.8, 199.95), {
    basis: 999.75,
    oreRounding: 0,
    toPayRounding: 0.25,
    invoice: { total: 999.75, remaining_amount: 999.75 },
  })
  // 1 000.40 to pay 1 000, its öre left for the payment: the write-off took 1 000.40 off 1510.
  const roundedDown = stateOf(writtenOff(1000.4, 800.32, 200.08), {
    basis: 1000.4,
    oreRounding: 0,
    toPayRounding: -0.4,
    invoice: { total: 1000.4, remaining_amount: 1000.4 },
  })
  // 999.75 to pay 1 000, the öre booked at issue: the write-off took 1 000 off 1510.
  const bookedAtIssue = stateOf(writtenOff(1000, 800.05, 199.95), {
    basis: 1000,
    oreRounding: 0.25,
    toPayRounding: 0.25,
    invoice: { total: 999.75, remaining_amount: 999.75 },
  })

  it('a payment of "Att betala" closes a claim rounded up, the öre credited to 3740', async () => {
    vi.mocked(loadCustomerLossState).mockResolvedValue({ ok: true, state: roundedUp })
    const { supabase, rpc } = mockSupabase()
    const outcome = await recordRecoveredLoss(supabase, COMPANY, USER, { ...params, amount: 1000 })
    expect(outcome).toMatchObject({ ok: true, amount: 999.75 })
    expect(lineTuples()).toEqual([
      ['1930', 1000, 0],
      ['3950', 0, 799.8],
      ['2611', 0, 199.95],
      ['3740', 0, 0.25],
    ])
    expect(rpc).toHaveBeenCalledWith(
      'record_invoice_write_off',
      expect.objectContaining({ p_kind: 'recovered', p_amount: 999.75, p_net_amount: 799.8, p_vat_amount: 199.95 }),
    )
  })

  it('a payment of "Att betala" closes a claim rounded down, reporting every VAT öre again', async () => {
    vi.mocked(loadCustomerLossState).mockResolvedValue({ ok: true, state: roundedDown })
    const { supabase, rpc } = mockSupabase()
    const outcome = await recordRecoveredLoss(supabase, COMPANY, USER, { ...params, amount: 1000 })
    expect(outcome).toMatchObject({ ok: true, amount: 1000.4 })
    expect(lineTuples()).toEqual([
      ['1930', 1000, 0],
      ['3950', 0, 800.32],
      ['2611', 0, 200.08],
      ['3740', 0.4, 0],
    ])
    expect(rpc).toHaveBeenCalledWith(
      'record_invoice_write_off',
      expect.objectContaining({ p_amount: 1000.4, p_net_amount: 800.32, p_vat_amount: 200.08 }),
    )
  })

  it("the agency's last part payment of 'Att betala' closes the claim", async () => {
    // 500 recovered first: 199.95 x 500 / 999.75 = 100 VAT. 499.75 left, the agency pays the last 500.
    const state = stateOf(
      writtenOff(999.75, 799.8, 199.95),
      { basis: 999.75, oreRounding: 0, toPayRounding: 0.25, invoice: { total: 999.75, remaining_amount: 999.75 } },
      [recoveryOf(500, 400, 100)],
    )
    vi.mocked(loadCustomerLossState).mockResolvedValue({ ok: true, state })
    const { supabase } = mockSupabase()
    const outcome = await recordRecoveredLoss(supabase, COMPANY, USER, { ...params, amount: 500, paymentAccount: '1689', fromCollectedPayment: true })
    expect(outcome).toMatchObject({ ok: true, amount: 499.75 })
    expect(lineTuples()).toEqual([
      ['1689', 500, 0],
      ['3950', 0, 399.8],
      ['2611', 0, 99.95],
      ['3740', 0, 0.25],
    ])
  })

  it('with the öre booked at issue, "Att betala" closes as before and the exact total closes too', async () => {
    vi.mocked(loadCustomerLossState).mockResolvedValue({ ok: true, state: bookedAtIssue })
    const { supabase } = mockSupabase()
    expect(await recordRecoveredLoss(supabase, COMPANY, USER, { ...params, amount: 1000 })).toMatchObject({ ok: true, amount: 1000 })
    expect(lineTuples()).toEqual([
      ['1930', 1000, 0],
      ['3950', 0, 800.05],
      ['2611', 0, 199.95],
    ])
    vi.mocked(createJournalEntry).mockClear()
    expect(await recordRecoveredLoss(supabase, COMPANY, USER, { ...params, amount: 999.75 })).toMatchObject({ ok: true, amount: 1000 })
    expect(lineTuples()).toEqual([
      ['1930', 999.75, 0],
      ['3950', 0, 800.05],
      ['2611', 0, 199.95],
      ['3740', 0.25, 0],
    ])
  })

  it('any other gap is not rounding: above what is left is refused, below it is a part payment', async () => {
    vi.mocked(loadCustomerLossState).mockResolvedValue({ ok: true, state: roundedUp })
    const { supabase } = mockSupabase()
    expect(await recordRecoveredLoss(supabase, COMPANY, USER, { ...params, amount: 1000.5 })).toMatchObject({
      ok: false,
      code: 'CUSTOMER_LOSS_RECOVERY_EXCEEDS',
    })
    expect(await recordRecoveredLoss(supabase, COMPANY, USER, { ...params, amount: 999.9 })).toMatchObject({
      ok: false,
      code: 'CUSTOMER_LOSS_RECOVERY_EXCEEDS',
    })
    expect(createJournalEntry).not.toHaveBeenCalled()
    // 999.50 is 0.25 short of what is left, and the invoice asked for 1 000: a part payment, no 3740.
    expect(await recordRecoveredLoss(supabase, COMPANY, USER, { ...params, amount: 999.5 })).toMatchObject({ ok: true, amount: 999.5 })
    expect(lineTuples().map(([account]) => account)).toEqual(['1930', '3950', '2611'])
  })

  it('a claim already recovered in full takes nothing more, not even its öre', async () => {
    const state = stateOf(
      writtenOff(999.75, 799.8, 199.95),
      { basis: 999.75, oreRounding: 0, toPayRounding: 0.25, invoice: { total: 999.75, remaining_amount: 999.75 } },
      [recoveryOf(999.75, 799.8, 199.95)],
    )
    vi.mocked(loadCustomerLossState).mockResolvedValue({ ok: true, state })
    const { supabase } = mockSupabase()
    expect(await recordRecoveredLoss(supabase, COMPANY, USER, { ...params, amount: 0.25 })).toMatchObject({
      ok: false,
      code: 'CUSTOMER_LOSS_RECOVERY_EXCEEDS',
    })
    expect(createJournalEntry).not.toHaveBeenCalled()
  })

  it('once a credit note changed what the invoice asks for, only what is left closes the claim', async () => {
    vi.mocked(loadCustomerLossState).mockResolvedValue({ ok: true, state: { ...roundedUp, toPayRounding: null } })
    const { supabase } = mockSupabase()
    expect(await recordRecoveredLoss(supabase, COMPANY, USER, { ...params, amount: 1000 })).toMatchObject({
      ok: false,
      code: 'CUSTOMER_LOSS_RECOVERY_EXCEEDS',
    })
    expect(buildCustomerLossView({ ...roundedUp, toPayRounding: null }, { enabled: true, today: '2026-07-01' }).recovery).toMatchObject({
      left: 999.75,
      closing: [],
    })
  })

  it('an invoice whose total is whole kronor closes only on what is left, whatever 3740 holds', async () => {
    // Imported: total 1 000 on 1510 with 0.25 on 3740 from the source system.
    const imported = stateOf(writtenOff(1000, 800.05, 199.95), {
      basis: 1000,
      oreRounding: 0.25,
      toPayRounding: 0,
      invoice: { total: 1000, remaining_amount: 1000 },
    })
    expect(buildCustomerLossView(imported, { enabled: true, today: '2026-07-01' }).recovery).toMatchObject({ left: 1000, closing: [] })
    vi.mocked(loadCustomerLossState).mockResolvedValue({ ok: true, state: imported })
    const { supabase } = mockSupabase()
    expect(await recordRecoveredLoss(supabase, COMPANY, USER, { ...params, amount: 999.75 })).toMatchObject({ ok: true, amount: 999.75 })
    expect(lineTuples().map(([account]) => account)).toEqual(['1930', '3950', '2611'])
  })

  it('the dialog may send "Att betala" as well as what is left', () => {
    const view = buildCustomerLossView(roundedUp, { enabled: true, today: '2026-07-01' })
    expect(view.recovery).toMatchObject({ left: 999.75, closing: [1000] })
    expect(buildCustomerLossView(bookedAtIssue, { enabled: true, today: '2026-07-01' }).recovery).toMatchObject({
      left: 1000,
      closing: [999.75],
    })
  })
})

describe("the invoice's own öresavrundning", () => {
  const invoice = { total: 999.75, currency: 'SEK', ore_rounding: null }
  it('is Att betala less the total, on by default', () => {
    expect(invoiceToPayRounding({ invoice, companyOreRounding: null, credited: false })).toBe(0.25)
    expect(invoiceToPayRounding({ invoice: { ...invoice, total: 1000.4 }, companyOreRounding: true, credited: false })).toBe(-0.4)
  })
  it("follows the invoice's own flag before the company's setting", () => {
    expect(invoiceToPayRounding({ invoice, companyOreRounding: false, credited: false })).toBe(0)
    expect(invoiceToPayRounding({ invoice: { ...invoice, ore_rounding: true }, companyOreRounding: false, credited: false })).toBe(0.25)
    expect(invoiceToPayRounding({ invoice: { ...invoice, ore_rounding: false }, companyOreRounding: true, credited: false })).toBe(0)
  })
  it('is 0 in another currency or on whole kronor, and unknown once credited', () => {
    expect(invoiceToPayRounding({ invoice: { ...invoice, currency: 'EUR' }, companyOreRounding: true, credited: false })).toBe(0)
    expect(invoiceToPayRounding({ invoice: { ...invoice, total: 1000 }, companyOreRounding: true, credited: false })).toBe(0)
    expect(invoiceToPayRounding({ invoice, companyOreRounding: true, credited: true })).toBeNull()
  })
})
