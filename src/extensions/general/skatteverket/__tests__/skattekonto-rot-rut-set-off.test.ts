import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'
import type { RotRutPayoutLeg } from '@/lib/bookkeeping/rot-rut-entries'

/**
 * Issue #93: under kontantmetodens two steps (rot-rut-payout-recognition.ts)
 * 1513 holds nothing during the year, so the seed rule "Rot/rut-utbetalning
 * kvittad på skattekontot" crediting 1513 drove it negative and never booked
 * Skatteverket's share's försäljning and moms. A set-off is the payout
 * itself, received on the skattekonto: it books the payout's own lines
 * (buildRotRutPayoutLines) and marks its begäran paid.
 */

vi.mock('@/lib/skatteverket/skattekonto-account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/skatteverket/skattekonto-account')>()),
  resolveSkattekontoAccount: vi.fn(async () => '1630'),
}))

vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bookkeeping/engine')>()
  return { ...actual, findFiscalPeriod: vi.fn(), createDraftEntry: vi.fn(), commitEntry: vi.fn() }
})

vi.mock('../lib/skattekonto-match', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/skattekonto-match')>()
  return { ...actual, findLedgerTwinCandidates: vi.fn(), findLedgerTwinCandidatesForIds: vi.fn() }
})

vi.mock('../lib/skattekonto-direct', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/skattekonto-direct')>()
  return { ...actual, findDirectLedgerHolders: vi.fn(), findDirectLedgerHoldersForIds: vi.fn() }
})

vi.mock('@/lib/reconciliation/skattekonto-reconciliation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/reconciliation/skattekonto-reconciliation')>()
  return { ...actual, getSkattekontoReconciliationStatus: vi.fn(), skattekontoPlannedHolds: vi.fn() }
})

// The payout's own reads, each covered by its own tests.
const loadOpenRequests = vi.fn()
vi.mock('@/lib/invoices/rot-rut-payout-candidates', () => ({
  loadOpenRotRutPayoutRequests: (...args: unknown[]) => loadOpenRequests(...args),
}))
const getRecognition = vi.fn()
vi.mock('@/lib/invoices/rot-rut-payout-recognition', () => ({
  getPayoutRecognition: (...args: unknown[]) => getRecognition(...args),
}))
const getOreRounding = vi.fn()
vi.mock('@/lib/invoices/rot-rut-receivable', () => ({
  getPayoutOreRounding: (...args: unknown[]) => getOreRounding(...args),
}))
const attachVoucher = vi.fn()
vi.mock('@/lib/invoices/rot-rut-settle', () => ({
  attachRotRutPayoutVoucher: (...args: unknown[]) => attachVoucher(...args),
}))

import { findFiscalPeriod, createDraftEntry } from '@/lib/bookkeeping/engine'
import { getSkattekontoReconciliationStatus, skattekontoPlannedHolds } from '@/lib/reconciliation/skattekonto-reconciliation'
import type { SkattekontoReconciliationResult } from '@/lib/reconciliation/skattekonto-reconciliation'
import { findLedgerTwinCandidates } from '../lib/skattekonto-match'
import { findDirectLedgerHolders } from '../lib/skattekonto-direct'
import {
  attachBookingSuggestions,
  bokforSkattekontoTransaction,
  buildSkattekontoEntry,
  guessCounterAccount,
  SkattekontoBookingError,
} from '../lib/skattekonto-booking'

const KVITTNING = 'Kvittning av utbetalning för rot- och rutarbeten'

const RULES = [
  {
    id: 'sys-0', priority: 5, pattern: 'kvittning av utbetalning för rot,kvittning av utbetalning för rut',
    amount_min: null, amount_max: null, company_type: 'all',
    counter_account: '1513', counter_account_ef: null,
    label: 'Rot/rut-utbetalning kvittad på skattekontot', active: true, requires_employer: false,
  },
]

const REQUEST = {
  id: 'req-1',
  name: 'ROT 2026-09',
  deduction_type: 'rot',
  status: 'submitted',
  requested_total: 3750,
  decided_total: null,
  settlement_journal_entry_id: null,
}

const RECOGNITION = {
  amount: 3750,
  lines: [
    { account_number: '3001', debit_amount: 0, credit_amount: 3000, line_description: 'Försäljning faktura 1042, ROT-avdrag' },
    { account_number: '2611', debit_amount: 0, credit_amount: 750, line_description: 'Utgående moms faktura 1042, ROT-avdrag' },
  ],
  invoices: [{ invoiceId: 'inv-1', paid: 3750 }],
}

const LEG: RotRutPayoutLeg = {
  requestId: 'req-1',
  requestName: 'ROT 2026-09',
  deductionType: 'rot',
  amount: 3750,
  oreRounding: 0,
  invoiceCount: 0,
  recognition: { amount: 3750, lines: RECOGNITION.lines },
}

const row = {
  id: 'row-1',
  company_id: 'company-1',
  transaktionstext: KVITTNING,
  transaktionsdatum: '2026-10-12',
  belopp_skatteverket: 3750,
  status: 'booked',
  journal_entry_id: null,
}

function net(lines: Array<{ account_number: string; debit_amount: number; credit_amount: number }>) {
  const out: Record<string, number> = {}
  for (const line of lines) {
    out[line.account_number] = Math.round(((out[line.account_number] ?? 0) + line.debit_amount - line.credit_amount) * 100) / 100
  }
  return out
}

beforeEach(() => {
  vi.clearAllMocks()
  loadOpenRequests.mockResolvedValue([REQUEST])
  getRecognition.mockResolvedValue({ ok: true, recognition: RECOGNITION })
  getOreRounding.mockResolvedValue({ rounding: 0, invoiceCount: 0 })
  attachVoucher.mockResolvedValue({ ok: true, request: { ...REQUEST, status: 'paid' }, fullyPaid: true })
  vi.mocked(findFiscalPeriod).mockResolvedValue('fp-1')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  vi.mocked(createDraftEntry).mockImplementation(async () => ({ id: 'je-draft-1' }) as any)
  vi.mocked(findLedgerTwinCandidates).mockImplementation(async (_s, _c, probes) => new Map(probes.map((p) => [p.id, []])))
  vi.mocked(findDirectLedgerHolders).mockImplementation(async (_s, _c, probes) => new Map(probes.map((p) => [p.id, []])))
  vi.mocked(getSkattekontoReconciliationStatus).mockResolvedValue({
    account_number: '1630',
    ledger_read_failed: false,
    cover: null,
  } as unknown as SkattekontoReconciliationResult)
  vi.mocked(skattekontoPlannedHolds).mockReturnValue(new Map())
})

const guess = (supabase: unknown) =>
  guessCounterAccount(supabase as SupabaseClient, 'company-1', KVITTNING, 'aktiebolag', 3750, false, '2026-10-12')

describe('a rot/rut set-off under kontantmetoden is its begäran\'s payout', () => {
  it('books the payout\'s lines with the skattekonto as the money in: revenue and moms, no 1513', () => {
    const entry = buildSkattekontoEntry(
      row,
      { account: '1513', label: 'Rot/rut-utbetalning kvittad på skattekontot', rotRutPayout: LEG },
      '1630',
    )
    expect(net(entry.lines)).toEqual({ '1630': 3750, '3001': -3000, '2611': -750 })
    expect(entry.lines[0]).toMatchObject({ account_number: '1630', debit_amount: 3750, line_description: KVITTNING })
    expect(entry.source_type).toBe('tax_account')
  })

  it('keeps 1513 for the part of a mixed begäran whose share is already on it', () => {
    const entry = buildSkattekontoEntry(
      { ...row, belopp_skatteverket: 5000 },
      { account: '1513', label: 'x', rotRutPayout: { ...LEG, amount: 5000 } },
      '1630',
    )
    expect(net(entry.lines)).toEqual({ '1630': 5000, '1513': -1250, '3001': -3000, '2611': -750 })
  })

  it('the guess carries the payout leg of the one open begäran expecting the amount', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: RULES })
    enqueue({ data: { accounting_method: 'cash' } })
    const match = await guess(supabase)
    expect(match).toMatchObject({ account: '1513', rotRutPayout: LEG })
    expect(getRecognition).toHaveBeenCalledWith(supabase, 'company-1', REQUEST, 3750, '2026-10-12')
  })

  it('keeps the rule\'s 1513: faktureringsmetoden, no matching begäran, or no invoice on the two steps', async () => {
    const accrual = createQueuedMockSupabase()
    accrual.enqueue({ data: RULES })
    accrual.enqueue({ data: { accounting_method: 'accrual' } })
    expect(await guess(accrual.supabase)).toEqual({ account: '1513', label: 'Rot/rut-utbetalning kvittad på skattekontot' })
    expect(loadOpenRequests).not.toHaveBeenCalled()

    const noMatch = createQueuedMockSupabase()
    noMatch.enqueue({ data: RULES })
    noMatch.enqueue({ data: { accounting_method: 'cash' } })
    loadOpenRequests.mockResolvedValueOnce([{ ...REQUEST, requested_total: 4000 }])
    expect(await guess(noMatch.supabase)).not.toHaveProperty('rotRutPayout')

    const oneStep = createQueuedMockSupabase()
    oneStep.enqueue({ data: RULES })
    oneStep.enqueue({ data: { accounting_method: 'cash' } })
    getRecognition.mockResolvedValueOnce({ ok: true, recognition: null })
    expect(await guess(oneStep.supabase)).toEqual({ account: '1513', label: 'Rot/rut-utbetalning kvittad på skattekontot' })
  })

  it('offers no account when the payout cannot be split per invoice: never a guess', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: RULES })
    enqueue({ data: { accounting_method: 'cash' } })
    getRecognition.mockResolvedValueOnce({ ok: false, code: 'ROT_RUT_SETTLE_DEDUCTION_SPLIT_UNKNOWN', details: {} })
    expect(await guess(supabase)).toBeNull()
  })

  it('the list suggestion carries the leg, so the approval preview shows the executor\'s lines', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: RULES })
    enqueue({ data: { entity_type: 'aktiebolag' } })
    enqueue({ data: { accounting_method: 'cash' } })
    const [suggested] = await attachBookingSuggestions(supabase as unknown as SupabaseClient, 'company-1', [row])
    expect(suggested.booking_suggestion).toMatchObject({
      account: '1513',
      rot_rut_payout: { request_id: 'req-1', request_name: 'ROT 2026-09', leg: LEG },
    })
  })

  it('booking it drafts the payout lines and marks the begäran paid before claiming the row', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: row }) // tx fetch
    enqueue({ data: RULES })
    enqueue({ data: { entity_type: 'aktiebolag' } })
    enqueue({ data: { accounting_method: 'cash' } })
    enqueue({ data: [{ id: row.id }] }) // claim

    await bokforSkattekontoTransaction(supabase as unknown as SupabaseClient, 'company-1', 'user-1', row.id)

    const input = vi.mocked(createDraftEntry).mock.calls[0][3]
    expect(net(input.lines)).toEqual({ '1630': 3750, '3001': -3000, '2611': -750 })
    expect(attachVoucher).toHaveBeenCalledWith(supabase, 'company-1', {
      requestId: 'req-1',
      journalEntryId: 'je-draft-1',
      amount: 3750,
    })
    // The single counter line the direct-booking check reads does not exist here.
    expect(findDirectLedgerHolders).not.toHaveBeenCalled()
  })

  it('a begäran settled meanwhile refuses the row and never claims it', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: row })
    enqueue({ data: RULES })
    enqueue({ data: { entity_type: 'aktiebolag' } })
    enqueue({ data: { accounting_method: 'cash' } })
    attachVoucher.mockResolvedValueOnce({ ok: false, kind: 'code', code: 'ROT_RUT_SETTLE_RACE' })

    const err = await bokforSkattekontoTransaction(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      row.id,
    ).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(SkattekontoBookingError)
    expect((err as SkattekontoBookingError).code).toBe('ALREADY_BOOKED')
    const claims = (supabase.from.mock.calls as unknown[][]).filter((call) => call[0] === 'skattekonto_transactions')
    expect(claims).toHaveLength(1) // the read only
  })
})
