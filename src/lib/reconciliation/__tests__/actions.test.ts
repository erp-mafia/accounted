import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createPagedMockSupabase, createQueuedMockSupabase, manyRows } from '@/tests/helpers'

// The company's skattekonto account (lib/skatteverket/skattekonto-account.ts):
// 1630 here, what every company resolved to before the setting existed.
vi.mock('@/lib/skatteverket/skattekonto-account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/skatteverket/skattekonto-account')>()),
  resolveSkattekontoAccount: vi.fn(async () => '1630'),
}))

const linkMock = vi.fn()
const linkGroupMock = vi.fn()
const unlinkMock = vi.fn()
const setIgnoredMock = vi.fn()
const manualLinkMock = vi.fn()
const linkToVouchersMock = vi.fn()
const junctionLinkedMock = vi.fn()
const unlinkReconciliationMock = vi.fn()
const skvStatusMock = vi.fn()
const emitMock = vi.fn()
const settleMock = vi.fn()
const undoSettlementMock = vi.fn()
const splitMock = vi.fn()
const releaseSkvSettlementMock = vi.fn()
const undoSkvSettlementMock = vi.fn()

vi.mock('@/lib/skatteverket/skattekonto-link', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/skatteverket/skattekonto-link')>()
  return {
    ...actual,
    linkSkattekontoRow: (...args: unknown[]) => linkMock(...args),
    linkSkattekontoRows: (...args: unknown[]) => linkGroupMock(...args),
    unlinkSkattekontoRow: (...args: unknown[]) => unlinkMock(...args),
    setSkattekontoRowIgnored: (...args: unknown[]) => setIgnoredMock(...args),
  }
})
vi.mock('../bank-reconciliation', () => ({
  manualLink: (...args: unknown[]) => manualLinkMock(...args),
  linkTransactionToVouchers: (...args: unknown[]) => linkToVouchersMock(...args),
  fetchJunctionLinkedTxIds: (...args: unknown[]) => junctionLinkedMock(...args),
  unlinkReconciliation: (...args: unknown[]) => unlinkReconciliationMock(...args),
}))
vi.mock('../skattekonto-reconciliation', () => ({
  getSkattekontoReconciliationStatus: (...args: unknown[]) => skvStatusMock(...args),
}))
vi.mock('@/lib/events/bus', () => ({ eventBus: { emit: (...args: unknown[]) => emitMock(...args) } }))
// The bank-row ignore rule (lib/transactions/ignore.ts) runs for real; only
// its suggestion-log side effect is observed here (record.ts has its suite).
const snapshotSuggestionsMock = vi.fn()
const recordDecisionsMock = vi.fn()
vi.mock('@/lib/suggestion-log/record', () => ({
  snapshotSuggestions: (...args: unknown[]) => snapshotSuggestionsMock(...args),
  recordDecisions: (...args: unknown[]) => recordDecisionsMock(...args),
}))
// The settlement policy has its own suite (ledger-settlement.test.ts); here
// only that a pair without outside rows reaches it, and what comes back.
vi.mock('../ledger-settlement', () => ({
  settleLedgerEntries: (...args: unknown[]) => settleMock(...args),
  undoLedgerSettlement: (...args: unknown[]) => undoSettlementMock(...args),
}))
// The skattekonto 1:N policy has its own suite (skattekonto-split.test.ts).
vi.mock('../skattekonto-split', () => ({
  splitSkattekontoRow: (...args: unknown[]) => splitMock(...args),
  releaseSkattekontoSettlementOf: (...args: unknown[]) => releaseSkvSettlementMock(...args),
  undoSkattekontoSettlement: (...args: unknown[]) => undoSkvSettlementMock(...args),
}))

import { SkattekontoLinkError } from '@/lib/skatteverket/skattekonto-link'
import { matchPairs, setItemIgnored, unmatchLink } from '../actions'

const COMPANY = 'company-1'
const USER = 'user-1'
const CASH = '11111111-1111-4111-8111-111111111111'
const R1 = '22222222-2222-4222-8222-222222222222'
const R2 = '33333333-3333-4333-8333-333333333333'
const E1 = '44444444-4444-4444-8444-444444444444'
const E2 = '55555555-5555-4555-8555-555555555555'

describe('matchPairs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    linkMock.mockReset()
    linkGroupMock.mockReset()
    manualLinkMock.mockReset()
    linkToVouchersMock.mockReset()
    skvStatusMock.mockReset()
    emitMock.mockResolvedValue(undefined)
  })

  it('returns null for an unknown or manual account key', async () => {
    const { supabase } = createQueuedMockSupabase()
    expect(await matchPairs(supabase as never, COMPANY, USER, 'nope', { pairs: [] })).toBeNull()
    expect(await matchPairs(supabase as never, COMPANY, USER, 'manual:1910', { pairs: [] })).toBeNull()
  })

  it('links skattekonto pairs one by one, groups N:1 through the sum-checked helper, and emits one event per row', async () => {
    const { supabase } = createQueuedMockSupabase()
    linkMock
      .mockResolvedValueOnce({ skattekonto_transaction_id: R1, journal_entry_id: E1, via: 'line' })
      .mockRejectedValueOnce(new SkattekontoLinkError('redan kopplat', 'ENTRY_ALREADY_LINKED'))
    linkGroupMock.mockResolvedValueOnce({
      journal_entry_id: E2,
      via: 'entry_total',
      skattekonto_transaction_ids: [R1, R2],
    })

    const result = await matchPairs(supabase as never, COMPANY, USER, 'skattekonto', {
      pairs: [
        { external_ids: [R1], journal_entry_ids: [E1] },
        { external_ids: [R2], journal_entry_ids: [E1] },
        { external_ids: [R1, R2], journal_entry_ids: [E2] },
        // N:M has no shape on any account.
        { external_ids: [R1, R2], journal_entry_ids: [E1, E2] },
      ],
    })

    expect(result).toMatchObject({ dry_run: false, considered: 4 })
    expect(result?.applied).toEqual([
      { external_id: R1, journal_entry_id: E1, via: 'line' },
      { external_id: R1, journal_entry_id: E2, via: 'entry_total' },
      { external_id: R2, journal_entry_id: E2, via: 'entry_total' },
    ])
    expect(result?.skipped.map((s) => s.code)).toEqual(['ALREADY_LINKED', 'UNSUPPORTED_PAIR_SHAPE'])
    expect(result?.skipped[1].message).toMatch(/en händelse mot flera verifikat/)
    expect(splitMock).not.toHaveBeenCalled()
    expect(linkToVouchersMock).not.toHaveBeenCalled()
    expect(linkGroupMock).toHaveBeenCalledWith(supabase, COMPANY, [R1, R2], E2, { account: '1630' })
    expect(emitMock).toHaveBeenCalledTimes(3)
    expect(emitMock.mock.calls[0][0]).toMatchObject({
      type: 'reconciliation.matched',
      payload: { accountKey: 'skattekonto', externalId: R1, journalEntryId: E1, method: 'manual' },
    })
  })

  it('links a bank N:1 group per transaction and reports partial failures per row', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ledger_account: '1930' } }) // cash_accounts lookup
    manualLinkMock
      .mockResolvedValueOnce({ success: true })
      .mockResolvedValueOnce({
        success: false,
        error: 'Transaktionen är redan kopplad till en verifikation.',
        code: 'TRANSACTION_ALREADY_LINKED',
      })

    const result = await matchPairs(supabase as never, COMPANY, USER, `bank:${CASH}`, {
      pairs: [{ external_ids: [R1, R2], journal_entry_ids: [E1] }],
    })

    expect(result).toMatchObject({ dry_run: false, considered: 1 })
    expect(result?.applied).toEqual([{ external_id: R1, journal_entry_id: E1 }])
    expect(result?.skipped).toEqual([
      {
        pair: { external_ids: [R2], journal_entry_ids: [E1] },
        code: 'ALREADY_LINKED',
        message: 'Transaktionen är redan kopplad till en verifikation.',
      },
    ])
    expect(emitMock).toHaveBeenCalledTimes(1)
  })

  it('dry run resolves proposals into pairs without writing', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    // The dry run checks the amounts too, as the live link does: the row,
    // the verifikat with its lines, and the rows already linked to it.
    enqueue({ data: [{ id: R1, journal_entry_id: null, is_ignored: false, belopp_skatteverket: 5000, status: 'booked' }] }) // skattekonto_transactions
    enqueue({
      data: [
        {
          id: E1,
          status: 'posted',
          voucher_series: 'A',
          voucher_number: 7,
          lines: [{ account_number: '1630', debit_amount: 5000, credit_amount: 0 }],
        },
      ],
    }) // journal_entries
    enqueue({ data: [] }) // rows already linked to the verifikat
    skvStatusMock.mockResolvedValue({
      items: {
        proposed: [
          { item_id: R1, proposal: { journal_entry_id: E1, confidence: 0.95 } },
          { item_id: R2, proposal: { journal_entry_id: E2, confidence: 0.8 } },
        ],
      },
    })

    const result = await matchPairs(
      supabase as never,
      COMPANY,
      USER,
      'skattekonto',
      { use_proposals: true, confidence_threshold: 0.9 },
      { dryRun: true },
    )

    expect(result).toMatchObject({ dry_run: true, considered: 1 })
    expect(result?.applied).toEqual([{ external_id: R1, journal_entry_id: E1, via: 'line' }])
    expect(linkMock).not.toHaveBeenCalled()
    expect(emitMock).not.toHaveBeenCalled()
  })

  it('turns a combined skattekonto proposal into ONE group pair (crm#128)', async () => {
    const { supabase } = createQueuedMockSupabase()
    skvStatusMock.mockResolvedValue({
      items: {
        proposed: [
          { item_id: R1, proposal: { journal_entry_id: E1, confidence: 0.9, external_ids: [R1, R2] } },
          { item_id: R2, proposal: { journal_entry_id: E1, confidence: 0.9, external_ids: [R1, R2] } },
        ],
      },
    })
    linkGroupMock.mockResolvedValue({ journal_entry_id: E1, via: 'line', skattekonto_transaction_ids: [R1, R2] })

    const result = await matchPairs(supabase as never, COMPANY, USER, 'skattekonto', { use_proposals: true })

    expect(result?.considered).toBe(1)
    expect(linkGroupMock).toHaveBeenCalledWith(supabase, COMPANY, [R1, R2], E1, { account: '1630' })
    expect(linkMock).not.toHaveBeenCalled()
    expect(result?.applied.map((a) => a.external_id)).toEqual([R1, R2])
  })

  it('links bank pairs through manualLink with the account ledger number', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ledger_account: '1931' } }) // cash_accounts lookup
    manualLinkMock.mockResolvedValue({ success: true })

    const result = await matchPairs(supabase as never, COMPANY, USER, `bank:${CASH}`, {
      pairs: [{ external_ids: [R1], journal_entry_ids: [E1] }],
    })

    // A pair the caller named takes the row's underlag onto the verifikat (crm#1101).
    expect(manualLinkMock).toHaveBeenCalledWith(supabase, COMPANY, R1, E1, USER, '1931', { anchorUnderlag: true })
    expect(result?.applied).toHaveLength(1)
  })

  it("anchors the row's underlag on the named bank pairs only, never on proposals applied in bulk (crm#1101)", async () => {
    // Anchoring cannot be undone by Koppla bort, so a guessed pair the
    // person did not look at one by one leaves the receipt on the row.
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [{ id: R2, potential_journal_entry_id: E2, potential_match_confidence: 0.95 }] }) // proposals
    enqueue({ data: { ledger_account: '1930' } }) // cash_accounts lookup
    manualLinkMock.mockResolvedValue({ success: true })

    const result = await matchPairs(supabase as never, COMPANY, USER, `bank:${CASH}`, {
      pairs: [{ external_ids: [R1], journal_entry_ids: [E1] }],
      use_proposals: true,
    })

    expect(result?.applied).toEqual([
      { external_id: R1, journal_entry_id: E1 },
      { external_id: R2, journal_entry_id: E2 },
    ])
    expect(manualLinkMock).toHaveBeenNthCalledWith(1, supabase, COMPANY, R1, E1, USER, '1930', { anchorUnderlag: true })
    expect(manualLinkMock).toHaveBeenNthCalledWith(2, supabase, COMPANY, R2, E2, USER, '1930', { anchorUnderlag: false })
  })

  it('splits ONE bank transaction over SEVERAL verifikat through linkTransactionToVouchers (1:N, #1553)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ledger_account: '1930' } }) // cash_accounts lookup, resolved once
    linkToVouchersMock.mockResolvedValue({
      success: true,
      allocations: [
        { journal_entry_id: E1, amount: -500 },
        { journal_entry_id: E2, amount: -300 },
      ],
    })

    const result = await matchPairs(supabase as never, COMPANY, USER, `bank:${CASH}`, {
      pairs: [{ external_ids: [R1], journal_entry_ids: [E1, E2] }],
    })

    // No allocations given: every slice is left undefined for the engine to
    // default to the voucher's bank line and enforce the sum.
    expect(linkToVouchersMock).toHaveBeenCalledWith(
      supabase,
      COMPANY,
      R1,
      [
        { journal_entry_id: E1, amount: undefined },
        { journal_entry_id: E2, amount: undefined },
      ],
      USER,
      '1930',
      { dryRun: false },
    )
    expect(manualLinkMock).not.toHaveBeenCalled()
    expect(result?.applied).toEqual([
      { external_id: R1, journal_entry_id: E1, allocated_amount: -500 },
      { external_id: R1, journal_entry_id: E2, allocated_amount: -300 },
    ])
    expect(result?.skipped).toEqual([])
    expect(emitMock).toHaveBeenCalledTimes(2)
    expect(emitMock.mock.calls[1][0]).toMatchObject({
      type: 'reconciliation.matched',
      payload: { accountKey: `bank:${CASH}`, externalId: R1, journalEntryId: E2 },
    })
  })

  it('hands a split over more than 50 verifikat to the engine, which owns the cap (crm#1144)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ledger_account: '1930' } })
    const ids = Array.from({ length: 138 }, (_, i) => `je-rut-${i}`)
    linkToVouchersMock.mockResolvedValue({
      success: true,
      allocations: ids.map((id) => ({ journal_entry_id: id, amount: 500 })),
    })

    const result = await matchPairs(supabase as never, COMPANY, USER, `bank:${CASH}`, {
      pairs: [{ external_ids: [R1], journal_entry_ids: ids }],
    })

    expect(linkToVouchersMock).toHaveBeenCalledTimes(1)
    expect(linkToVouchersMock.mock.calls[0][3]).toHaveLength(138)
    expect(result?.skipped).toEqual([])
    expect(result?.applied).toHaveLength(138)
  })

  it('forwards explicit allocations, refuses a set that does not name exactly the pair\'s verifikat, and never writes on dry run', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ledger_account: '1931' } })
    linkToVouchersMock.mockResolvedValue({
      success: true,
      allocations: [
        { journal_entry_id: E1, amount: -450 },
        { journal_entry_id: E2, amount: -350 },
      ],
    })

    const result = await matchPairs(
      supabase as never,
      COMPANY,
      USER,
      `bank:${CASH}`,
      {
        pairs: [
          {
            external_ids: [R1],
            journal_entry_ids: [E1, E2],
            allocations: [
              { journal_entry_id: E1, amount: -450 },
              { journal_entry_id: E2, amount: -350 },
            ],
          },
          // Names a verifikat outside the pair: refused before the engine.
          { external_ids: [R2], journal_entry_ids: [E1, E2], allocations: [{ journal_entry_id: E1, amount: -800 }] },
          // N:M has no engine shape on either account kind.
          { external_ids: [R1, R2], journal_entry_ids: [E1, E2] },
        ],
      },
      { dryRun: true },
    )

    expect(linkToVouchersMock).toHaveBeenCalledTimes(1)
    expect(linkToVouchersMock).toHaveBeenCalledWith(
      supabase,
      COMPANY,
      R1,
      [
        { journal_entry_id: E1, amount: -450 },
        { journal_entry_id: E2, amount: -350 },
      ],
      USER,
      '1931',
      { dryRun: true },
    )
    expect(result?.applied).toHaveLength(2)
    expect(result?.skipped.map((s) => s.code)).toEqual(['UNSUPPORTED_PAIR_SHAPE', 'UNSUPPORTED_PAIR_SHAPE'])
    expect(result?.skipped[0].message).toMatch(/allocations/)
    expect(emitMock).not.toHaveBeenCalled()
  })

  it('a refused split is one PAIR_NOT_CLOSED skip for the whole pair (all or nothing)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ledger_account: '1930' } })
    linkToVouchersMock.mockResolvedValue({
      success: false,
      error: 'Fördelningen (-700) stämmer inte med transaktionens belopp (-800).',
      code: 'NOT_SETTLED',
    })

    const result = await matchPairs(supabase as never, COMPANY, USER, `bank:${CASH}`, {
      pairs: [{ external_ids: [R1], journal_entry_ids: [E1, E2] }],
    })

    expect(result?.applied).toEqual([])
    expect(result?.skipped).toEqual([
      {
        pair: { external_ids: [R1], journal_entry_ids: [E1, E2] },
        code: 'PAIR_NOT_CLOSED',
        message: 'Fördelningen (-700) stämmer inte med transaktionens belopp (-800).',
      },
    ])
    expect(emitMock).not.toHaveBeenCalled()
  })

  it('a failed bank link is a skip, not a throw: PAIR_NOT_CLOSED only when the verifikat does not settle the row', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ledger_account: '1930' } })
    manualLinkMock.mockResolvedValue({ success: false, error: 'Verifikationen saknar rad på 1930', code: 'NOT_SETTLED' })

    const result = await matchPairs(supabase as never, COMPANY, USER, `bank:${CASH}`, {
      pairs: [{ external_ids: [R1], journal_entry_ids: [E1] }],
    })
    expect(result?.skipped[0]).toMatchObject({ code: 'PAIR_NOT_CLOSED', message: 'Verifikationen saknar rad på 1930' })
  })

  it('maps every manualLink refusal to its own skip code (feedback seq 740266: a missing verifikat read as PAIR_NOT_CLOSED)', async () => {
    const cases: Array<[string, string]> = [
      ['TRANSACTION_NOT_FOUND', 'NOT_FOUND'],
      ['TRANSACTION_OTHER_ACCOUNT', 'NOT_FOUND'],
      ['TRANSACTION_IGNORED', 'ROW_IGNORED'],
      ['TRANSACTION_ALREADY_LINKED', 'ALREADY_LINKED'],
      ['ENTRY_NOT_FOUND', 'ENTRY_NOT_FOUND'],
      ['ENTRY_NOT_POSTED', 'ENTRY_NOT_FOUND'],
      ['ENTRY_REVERSED', 'ENTRY_REVERSED'],
      ['NOT_SETTLED', 'PAIR_NOT_CLOSED'],
      ['LINK_RACE', 'LINK_RACE'],
      ['BANK_ANCHOR_REFUSED', 'BANK_ANCHOR_REFUSED'],
      ['OVER_ALLOCATED', 'PAIR_NOT_CLOSED'],
      ['WRITE_FAILED', 'UNKNOWN'],
    ]
    for (const [engineCode, skipCode] of cases) {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: { ledger_account: '1930' } })
      manualLinkMock.mockResolvedValueOnce({ success: false, error: `refused: ${engineCode}`, code: engineCode })

      const result = await matchPairs(supabase as never, COMPANY, USER, `bank:${CASH}`, {
        pairs: [{ external_ids: [R1], journal_entry_ids: [E1] }],
      })
      expect(result?.skipped, engineCode).toEqual([
        { pair: { external_ids: [R1], journal_entry_ids: [E1] }, code: skipCode, message: `refused: ${engineCode}` },
      ])
    }
    // A refusal without a code (an older engine) is honest about not knowing.
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ledger_account: '1930' } })
    manualLinkMock.mockResolvedValueOnce({ success: false, error: 'något' })
    const result = await matchPairs(supabase as never, COMPANY, USER, `bank:${CASH}`, {
      pairs: [{ external_ids: [R1], journal_entry_ids: [E1] }],
    })
    expect(result?.skipped[0].code).toBe('UNKNOWN')
  })

  it('a split the bank-anchor guard refused is BANK_ANCHOR_REFUSED, not UNKNOWN (agent feedback seq 853921, 877706)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ledger_account: '1930' } })
    linkToVouchersMock.mockResolvedValue({
      success: false,
      error: 'Kopplingen nekades: verifikationen bokför inte beloppet på bankkontot åt samma håll som transaktionen.',
      code: 'BANK_ANCHOR_REFUSED',
    })

    const result = await matchPairs(supabase as never, COMPANY, USER, `bank:${CASH}`, {
      pairs: [
        {
          external_ids: [R1],
          journal_entry_ids: [E1, E2],
          allocations: [
            { journal_entry_id: E1, amount: -120 },
            { journal_entry_id: E2, amount: 20 },
          ],
        },
      ],
    })

    expect(result?.applied).toEqual([])
    expect(result?.skipped).toHaveLength(1)
    expect(result?.skipped[0]).toMatchObject({ code: 'BANK_ANCHOR_REFUSED' })
    expect(result?.skipped[0].message).toMatch(/^Kopplingen nekades/)
  })

  it('maps a refused 1:N split the same way: a missing verifikat is ENTRY_NOT_FOUND, a bad split shape UNSUPPORTED_PAIR_SHAPE', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ledger_account: '1930' } })
    linkToVouchersMock
      .mockResolvedValueOnce({ success: false, error: `Verifikationen ${E2} kunde inte hittas.`, code: 'ENTRY_NOT_FOUND' })
      .mockResolvedValueOnce({ success: false, error: 'Transaktionen är redan matchad mot en faktura.', code: 'TRANSACTION_ALREADY_LINKED' })

    const result = await matchPairs(
      supabase as never,
      COMPANY,
      USER,
      `bank:${CASH}`,
      {
        pairs: [
          { external_ids: [R1], journal_entry_ids: [E1, E2] },
          { external_ids: [R2], journal_entry_ids: [E1, E2] },
        ],
      },
      { dryRun: true },
    )

    expect(result?.applied).toEqual([])
    expect(result?.skipped.map((s) => s.code)).toEqual(['ENTRY_NOT_FOUND', 'ALREADY_LINKED'])
    expect(result?.skipped[0].message).toContain(E2)
  })

  it('applies every bank proposal with use_proposals when there are more than 1,000', async () => {
    const { supabase } = createPagedMockSupabase({
      transactions: manyRows(1001, (i) => ({
        id: `tx-${i}`,
        potential_journal_entry_id: `je-${i}`,
        potential_match_confidence: 0.95,
      })),
      cash_accounts: [{ ledger_account: '1930' }],
    })
    manualLinkMock.mockResolvedValue({ success: true })

    const result = await matchPairs(supabase as never, COMPANY, USER, `bank:${CASH}`, { use_proposals: true })

    expect(result?.considered).toBe(1001)
    expect(result?.applied).toHaveLength(1001)
  })
})

describe('matchPairs: verifikat with no outside row, settled against each other (crm#1074)', () => {
  const SETTLEMENT = {
    settlement_id: '66666666-6666-4666-8666-666666666666',
    account_number: '1930',
    entries: [
      { journal_entry_id: E1, voucher_series: 'A', voucher_number: 12, entry_date: '2026-03-18', amount: -1250 },
      { journal_entry_id: E2, voucher_series: 'A', voucher_number: 31, entry_date: '2026-04-21', amount: 1250 },
    ],
  }

  beforeEach(() => {
    vi.clearAllMocks()
    manualLinkMock.mockReset()
    linkToVouchersMock.mockReset()
    settleMock.mockReset()
    emitMock.mockResolvedValue(undefined)
  })

  it('hands a pair without outside rows to the settlement policy and reports it in settled, not applied', async () => {
    const { supabase } = createQueuedMockSupabase()
    settleMock.mockResolvedValue({ ok: true, settlement: SETTLEMENT })

    const result = await matchPairs(supabase as never, COMPANY, USER, `bank:${CASH}`, {
      pairs: [{ external_ids: [], journal_entry_ids: [E1, E2] }],
    })

    expect(settleMock).toHaveBeenCalledWith(supabase, COMPANY, USER, `bank:${CASH}`, [E1, E2], { dryRun: false })
    expect(result).toEqual({ dry_run: false, considered: 1, applied: [], settled: [SETTLEMENT], skipped: [] })
    // No bank link was attempted and no link event went out: nothing was linked to a bank row.
    expect(manualLinkMock).not.toHaveBeenCalled()
    expect(linkToVouchersMock).not.toHaveBeenCalled()
    expect(emitMock).not.toHaveBeenCalled()
  })

  it('previews through the same policy on a dry run, without the pair-fact reads of a bank link', async () => {
    const { supabase, calls } = createQueuedMockSupabase()
    settleMock.mockResolvedValue({ ok: true, settlement: { ...SETTLEMENT, settlement_id: null } })

    const result = await matchPairs(
      supabase as never,
      COMPANY,
      USER,
      `bank:${CASH}`,
      { pairs: [{ external_ids: [], journal_entry_ids: [E1, E2] }] },
      { dryRun: true },
    )

    expect(settleMock).toHaveBeenCalledWith(supabase, COMPANY, USER, `bank:${CASH}`, [E1, E2], { dryRun: true })
    expect(result?.settled).toEqual([{ ...SETTLEMENT, settlement_id: null }])
    expect(calls).toEqual([])
  })

  it('reports a refusal as a skipped pair with the policy code and sentence, and keeps linking the other pairs', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { ledger_account: '1930' } }) // cash_accounts lookup for the bank link
    settleMock.mockResolvedValue({ ok: false, code: 'PAIR_NOT_CLOSED', message: 'Verifikaten tar inte ut varandra.' })
    manualLinkMock.mockResolvedValue({ success: true })
    const ledgerOnly = { external_ids: [], journal_entry_ids: [E1, E2] }

    const result = await matchPairs(supabase as never, COMPANY, USER, `bank:${CASH}`, {
      pairs: [ledgerOnly, { external_ids: [R1], journal_entry_ids: [E1] }],
    })

    expect(result?.settled).toEqual([])
    expect(result?.skipped).toEqual([{ pair: ledgerOnly, code: 'PAIR_NOT_CLOSED', message: 'Verifikaten tar inte ut varandra.' }])
    expect(result?.applied).toEqual([{ external_id: R1, journal_entry_id: E1 }])
  })

  it('refuses allocations on a pair without an outside row before the policy runs', async () => {
    const { supabase } = createQueuedMockSupabase()
    const pair = {
      external_ids: [],
      journal_entry_ids: [E1, E2],
      allocations: [
        { journal_entry_id: E1, amount: -1250 },
        { journal_entry_id: E2, amount: 1250 },
      ],
    }
    const result = await matchPairs(supabase as never, COMPANY, USER, `bank:${CASH}`, { pairs: [pair] })
    expect(result?.skipped.map((s) => s.code)).toEqual(['UNSUPPORTED_PAIR_SHAPE'])
    expect(settleMock).not.toHaveBeenCalled()
  })

  it('forwards the skattekonto key too: the policy, not the door, decides which accounts can settle', async () => {
    const { supabase } = createQueuedMockSupabase()
    settleMock.mockResolvedValue({ ok: false, code: 'UNSUPPORTED_PAIR_SHAPE', message: 'Bara på ett bankkonto.' })
    const result = await matchPairs(supabase as never, COMPANY, USER, 'skattekonto', {
      pairs: [{ external_ids: [], journal_entry_ids: [E1, E2] }],
    })
    expect(settleMock).toHaveBeenCalledWith(supabase, COMPANY, USER, 'skattekonto', [E1, E2], { dryRun: false })
    expect(result?.skipped.map((s) => s.code)).toEqual(['UNSUPPORTED_PAIR_SHAPE'])
    expect(linkMock).not.toHaveBeenCalled()
  })

  it('a thrown read error is a skip, not a 500 for the whole request', async () => {
    const { supabase } = createQueuedMockSupabase()
    settleMock.mockRejectedValue(new Error('Kunde inte läsa verifikaten: timeout'))
    const result = await matchPairs(supabase as never, COMPANY, USER, `bank:${CASH}`, {
      pairs: [{ external_ids: [], journal_entry_ids: [E1, E2] }],
    })
    expect(result?.skipped).toMatchObject([{ code: 'UNKNOWN', message: 'Kunde inte läsa verifikaten: timeout' }])
  })
})

describe('matchPairs dry run: every pair is checked against the ledger before anything is staged', () => {
  const E3 = '66666666-6666-4666-8666-666666666666'
  const TYPO = 'ecb5d7ef-e0d1-4da6-ab18-5651c2c8ec9b' // one character off a real id (feedback seq 740266)
  const R3 = '77777777-7777-4777-8777-777777777777'
  const R4 = '88888888-8888-4888-8888-888888888888'
  const R5 = '99999999-9999-4999-8999-999999999999'
  const posted = (id: string, voucher_number = 21) => ({ id, status: 'posted', voucher_series: 'A', voucher_number })
  const bankRow = (id: string, over: Record<string, unknown> = {}) => ({
    id,
    journal_entry_id: null,
    is_ignored: false,
    transaction_voucher_links: [],
    ...over,
  })

  beforeEach(() => {
    vi.clearAllMocks()
    manualLinkMock.mockReset()
    linkMock.mockReset()
    linkGroupMock.mockReset()
    linkToVouchersMock.mockReset()
    emitMock.mockResolvedValue(undefined)
  })

  it('skips a pair whose verifikat is not in the company with ENTRY_NOT_FOUND naming the id, and keeps the rest', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [bankRow(R1), bankRow(R2)] }) // transactions
    enqueue({ data: [posted(E2, 22)] }) // journal_entries: the typo matches nothing

    const result = await matchPairs(
      supabase as never,
      COMPANY,
      USER,
      `bank:${CASH}`,
      {
        pairs: [
          { external_ids: [R1], journal_entry_ids: [TYPO] },
          { external_ids: [R2], journal_entry_ids: [E2] },
        ],
      },
      { dryRun: true },
    )

    expect(result).toMatchObject({ dry_run: true, considered: 2 })
    expect(result?.applied).toEqual([{ external_id: R2, journal_entry_id: E2 }])
    expect(result?.skipped).toEqual([
      {
        pair: { external_ids: [R1], journal_entry_ids: [TYPO] },
        code: 'ENTRY_NOT_FOUND',
        message: `Verifikationen ${TYPO} finns inte i företaget. Kontrollera id:t.`,
      },
    ])
    // Two batched reads, both company-scoped; nothing linked or written.
    expect(findCalls('transactions', 'eq')).toContainEqual(['company_id', COMPANY])
    expect(findCalls('journal_entries', 'eq')).toContainEqual(['company_id', COMPANY])
    expect(findCalls('journal_entries', 'in')).toEqual([['id', [TYPO, E2]]])
    expect(findCalls('transactions', 'update')).toEqual([])
    expect(manualLinkMock).not.toHaveBeenCalled()
    expect(emitMock).not.toHaveBeenCalled()
  })

  it('checks each bank row on its own: missing, ignored, linked to a live verifikat or through a junction row; a stale pointer at a reversed entry stays linkable (#988)', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({
      data: [
        bankRow(R2, { is_ignored: true }),
        bankRow(R3, { journal_entry_id: E2 }),
        bankRow(R4, { journal_entry_id: E3 }),
        bankRow(R5, { transaction_voucher_links: [{ role: 'bank_line' }] }),
      ],
    })
    enqueue({ data: [posted(E1), posted(E2, 5), { id: E3, status: 'reversed', voucher_series: 'A', voucher_number: 6 }] })

    const result = await matchPairs(
      supabase as never,
      COMPANY,
      USER,
      `bank:${CASH}`,
      { pairs: [{ external_ids: [R1, R2, R3, R4, R5], journal_entry_ids: [E1] }] },
      { dryRun: true },
    )

    expect(result?.applied).toEqual([{ external_id: R4, journal_entry_id: E1 }])
    expect(result?.skipped.map((s) => [s.pair.external_ids[0], s.code])).toEqual([
      [R1, 'NOT_FOUND'],
      [R2, 'ROW_IGNORED'],
      [R3, 'ALREADY_LINKED'],
      [R5, 'ALREADY_LINKED'],
    ])
    expect(result?.skipped[0].message).toBe(`Transaktionen ${R1} finns inte i företaget. Kontrollera id:t.`)
    // The rows' pointers are read with the pair's verifikat, in one query.
    expect(findCalls('journal_entries', 'in')).toEqual([['id', [E1, E2, E3]]])
  })

  it('refuses a reversed verifikat as ENTRY_REVERSED and a draft as ENTRY_NOT_FOUND', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [bankRow(R1), bankRow(R2)] })
    enqueue({
      data: [
        { id: E1, status: 'reversed', voucher_series: 'A', voucher_number: 12 },
        { id: E2, status: 'draft', voucher_series: 'A', voucher_number: null },
      ],
    })

    const result = await matchPairs(
      supabase as never,
      COMPANY,
      USER,
      `bank:${CASH}`,
      {
        pairs: [
          { external_ids: [R1], journal_entry_ids: [E1] },
          { external_ids: [R2], journal_entry_ids: [E2] },
        ],
      },
      { dryRun: true },
    )

    expect(result?.applied).toEqual([])
    expect(result?.skipped).toEqual([
      {
        pair: { external_ids: [R1], journal_entry_ids: [E1] },
        code: 'ENTRY_REVERSED',
        message: `Verifikat A12 (${E1}) är makulerat och kan inte kopplas.`,
      },
      {
        pair: { external_ids: [R2], journal_entry_ids: [E2] },
        code: 'ENTRY_NOT_FOUND',
        message: `Verifikationen ${E2} är inte bokförd.`,
      },
    ])
  })

  it('skips a skattekonto group as a whole when one row cannot be linked (all or nothing)', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({
      data: [
        { id: R1, journal_entry_id: null, is_ignored: false },
        { id: R2, journal_entry_id: E2, is_ignored: false },
      ],
    }) // skattekonto_transactions
    enqueue({ data: [posted(E1)] })

    const result = await matchPairs(
      supabase as never,
      COMPANY,
      USER,
      'skattekonto',
      { pairs: [{ external_ids: [R1, R2], journal_entry_ids: [E1] }] },
      { dryRun: true },
    )

    expect(result?.applied).toEqual([])
    expect(result?.skipped).toEqual([
      {
        pair: { external_ids: [R1, R2], journal_entry_ids: [E1] },
        code: 'ALREADY_LINKED',
        message: `Skattekonto-transaktionen ${R2} är redan kopplad till en verifikation.`,
      },
    ])
    expect(linkMock).not.toHaveBeenCalled()
    expect(linkGroupMock).not.toHaveBeenCalled()
  })

  it('never sends a malformed id to the database: it is simply not found', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: [bankRow(R1)] })

    const result = await matchPairs(
      supabase as never,
      COMPANY,
      USER,
      `bank:${CASH}`,
      { pairs: [{ external_ids: [R1], journal_entry_ids: ['A21'] }] },
      { dryRun: true },
    )

    expect(result?.skipped[0]).toMatchObject({ code: 'ENTRY_NOT_FOUND' })
    // No verifikat id survived the shape check, so no verifikat query ran.
    expect(findCalls('journal_entries', 'in')).toEqual([])
  })

  it('fails the dry run on a read error instead of staging unchecked pairs', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } })

    await expect(
      matchPairs(
        supabase as never,
        COMPANY,
        USER,
        `bank:${CASH}`,
        { pairs: [{ external_ids: [R1], journal_entry_ids: [E1] }] },
        { dryRun: true },
      ),
    ).rejects.toMatchObject({ code: '57014' })
  })
})

// crm#1043: rows against one summarised verifikat (the year booked as one
// voucher, part of it from before the fetched history). All figures made up.
describe('matchPairs: skattekonto rows against a summarised verifikat (allow_remainder)', () => {
  const R3 = '77777777-7777-4777-8777-777777777777'
  const skvRow = (id: string, belopp: number, over: Record<string, unknown> = {}) => ({
    id,
    journal_entry_id: null,
    is_ignored: false,
    belopp_skatteverket: belopp,
    status: 'booked',
    ...over,
  })
  // Net on 1630: 300 000 - 180 000.50 - 82 500.25 = 37 499.25
  const summarised = (id: string, lines?: unknown[]) => ({
    id,
    status: 'posted',
    voucher_series: 'B',
    voucher_number: 1,
    lines: lines ?? [
      { account_number: '1630', debit_amount: 300000, credit_amount: 0 },
      { account_number: '1630', debit_amount: 0, credit_amount: 180000.5 },
      { account_number: '1630', debit_amount: 0, credit_amount: 82500.25 },
      { account_number: '1930', debit_amount: 0, credit_amount: 300000 },
    ],
  })
  const pair = { external_ids: [R1, R2, R3], journal_entry_ids: [E1] }
  const rows = [skvRow(R1, 100000), skvRow(R2, -60000.5), skvRow(R3, -20000)]

  beforeEach(() => {
    vi.clearAllMocks()
    linkMock.mockReset()
    linkGroupMock.mockReset()
    emitMock.mockResolvedValue(undefined)
  })

  it('live: without the flag the helper is called exactly as before and its refusal is PAIR_NOT_CLOSED', async () => {
    const { supabase } = createQueuedMockSupabase()
    linkGroupMock.mockRejectedValueOnce(new SkattekontoLinkError('motsvarar inte summan', 'INVALID_CANDIDATE'))
    const result = await matchPairs(supabase as never, COMPANY, USER, 'skattekonto', { pairs: [pair] })
    expect(linkGroupMock).toHaveBeenCalledWith(supabase, COMPANY, [R1, R2, R3], E1, { account: '1630' })
    expect(result?.applied).toEqual([])
    expect(result?.skipped.map((s) => s.code)).toEqual(['PAIR_NOT_CLOSED'])
    expect(emitMock).not.toHaveBeenCalled()
  })

  it('live: allow_remainder reaches the helper, and every applied link carries via partial and what stays on the verifikat', async () => {
    const { supabase } = createQueuedMockSupabase()
    linkGroupMock.mockResolvedValueOnce({
      journal_entry_id: E1,
      via: 'partial',
      skattekonto_transaction_ids: [R1, R2, R3],
      remainder: 17499.75,
    })
    const result = await matchPairs(supabase as never, COMPANY, USER, 'skattekonto', {
      pairs: [{ ...pair, allow_remainder: true }],
    })
    expect(linkGroupMock).toHaveBeenCalledWith(supabase, COMPANY, [R1, R2, R3], E1, {
      allowRemainder: true,
      account: '1630',
    })
    expect(result?.applied).toEqual(
      [R1, R2, R3].map((id) => ({ external_id: id, journal_entry_id: E1, via: 'partial', remainder_amount: 17499.75 })),
    )
    expect(result?.skipped).toEqual([])
    expect(emitMock).toHaveBeenCalledTimes(3)
  })

  it('live: one row with allow_remainder goes through the single-row helper with the same option', async () => {
    const { supabase } = createQueuedMockSupabase()
    linkMock.mockResolvedValueOnce({ skattekonto_transaction_id: R1, journal_entry_id: E1, via: 'partial', remainder: -62500.75 })
    const result = await matchPairs(supabase as never, COMPANY, USER, 'skattekonto', {
      pairs: [{ external_ids: [R1], journal_entry_ids: [E1], allow_remainder: true }],
    })
    expect(linkMock).toHaveBeenCalledWith(supabase, COMPANY, R1, E1, { allowRemainder: true, account: '1630' })
    expect(result?.applied).toEqual([{ external_id: R1, journal_entry_id: E1, via: 'partial', remainder_amount: -62500.75 }])
  })

  it('live: an exact link reports no remainder_amount (the helper says 0)', async () => {
    const { supabase } = createQueuedMockSupabase()
    linkMock.mockResolvedValueOnce({ skattekonto_transaction_id: R1, journal_entry_id: E1, via: 'line', remainder: 0 })
    const result = await matchPairs(supabase as never, COMPANY, USER, 'skattekonto', {
      pairs: [{ external_ids: [R1], journal_entry_ids: [E1] }],
    })
    expect(linkMock).toHaveBeenCalledWith(supabase, COMPANY, R1, E1, { account: '1630' })
    expect(result?.applied).toEqual([{ external_id: R1, journal_entry_id: E1, via: 'line' }])
  })

  it('dry run: the pair is refused at stage time, with both sums, the remainder and allow_remainder named', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: rows })
    enqueue({ data: [summarised(E1)] })
    enqueue({ data: [] })
    const result = await matchPairs(supabase as never, COMPANY, USER, 'skattekonto', { pairs: [pair] }, { dryRun: true })
    expect(result?.applied).toEqual([])
    expect(result?.skipped).toHaveLength(1)
    expect(result?.skipped[0]).toMatchObject({ pair, code: 'PAIR_NOT_CLOSED' })
    expect(result?.skipped[0].message).toContain('motsvarar inte summan av de valda händelserna')
    expect(result?.skipped[0].message).toContain('allow_remainder')
    // Reads only: the rows, the verifikat with its lines, the rows already linked to it.
    expect(findCalls('skattekonto_transactions', 'update')).toEqual([])
    expect(findCalls('skattekonto_transactions', 'in')).toEqual([
      ['id', [R1, R2, R3]],
      ['journal_entry_id', [E1]],
    ])
    expect(linkGroupMock).not.toHaveBeenCalled()
  })

  it('dry run: with allow_remainder the preview shows via partial and the remainder, and writes nothing', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: rows })
    enqueue({ data: [summarised(E1)] })
    enqueue({ data: [] })
    const result = await matchPairs(
      supabase as never,
      COMPANY,
      USER,
      'skattekonto',
      { pairs: [{ ...pair, allow_remainder: true }] },
      { dryRun: true },
    )
    expect(result?.skipped).toEqual([])
    expect(result?.applied).toEqual(
      [R1, R2, R3].map((id) => ({ external_id: id, journal_entry_id: E1, via: 'partial', remainder_amount: 17499.75 })),
    )
    expect(findCalls('skattekonto_transactions', 'update')).toEqual([])
    expect(linkGroupMock).not.toHaveBeenCalled()
    expect(emitMock).not.toHaveBeenCalled()
  })

  it('dry run: rows already linked to the verifikat count in the remainder, and a second pair sees the first', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [skvRow(R1, -60000.5), skvRow(R2, -20000)] })
    enqueue({ data: [summarised(E1)] })
    enqueue({ data: [{ id: 'linked-1', journal_entry_id: E1, belopp_skatteverket: 100000 }] })
    const result = await matchPairs(
      supabase as never,
      COMPANY,
      USER,
      'skattekonto',
      {
        pairs: [
          { external_ids: [R1], journal_entry_ids: [E1], allow_remainder: true },
          { external_ids: [R2], journal_entry_ids: [E1], allow_remainder: true },
        ],
      },
      { dryRun: true },
    )
    expect(result?.applied).toEqual([
      // 37 499.25 - 100 000 + 60 000.50
      { external_id: R1, journal_entry_id: E1, via: 'partial', remainder_amount: -2500.25 },
      // ... + 20 000
      { external_id: R2, journal_entry_id: E1, via: 'partial', remainder_amount: 17499.75 },
    ])
  })

  it('dry run: guard rails hold with the flag (no 1630 line, a kommande row)', async () => {
    const { supabase, enqueue, reset } = createQueuedMockSupabase()
    enqueue({ data: rows })
    enqueue({ data: [summarised(E1, [{ account_number: '1930', debit_amount: 0, credit_amount: 5000 }])] })
    enqueue({ data: [] })
    const noLine = await matchPairs(
      supabase as never,
      COMPANY,
      USER,
      'skattekonto',
      { pairs: [{ ...pair, allow_remainder: true }] },
      { dryRun: true },
    )
    expect(noLine?.applied).toEqual([])
    expect(noLine?.skipped[0]).toMatchObject({ code: 'PAIR_NOT_CLOSED', message: expect.stringContaining('ingen rad på 1630') })

    reset()
    enqueue({ data: [skvRow(R1, 100000), skvRow(R2, -60000.5, { status: 'upcoming' }), skvRow(R3, -20000)] })
    enqueue({ data: [summarised(E1)] })
    enqueue({ data: [] })
    const upcoming = await matchPairs(
      supabase as never,
      COMPANY,
      USER,
      'skattekonto',
      { pairs: [{ ...pair, allow_remainder: true }] },
      { dryRun: true },
    )
    expect(upcoming?.applied).toEqual([])
    expect(upcoming?.skipped[0]).toMatchObject({ code: 'PAIR_NOT_CLOSED', message: 'En kommande händelse kan inte kopplas ännu.' })
  })

  it('dry run: an exact pair previews as before, plus how it settles, and no remainder', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: [skvRow(R1, -4521), skvRow(R2, -7704)] })
    enqueue({ data: [summarised(E1, [{ account_number: '1630', debit_amount: 0, credit_amount: 12225 }])] })
    enqueue({ data: [] })
    const result = await matchPairs(
      supabase as never,
      COMPANY,
      USER,
      'skattekonto',
      { pairs: [{ external_ids: [R1, R2], journal_entry_ids: [E1] }] },
      { dryRun: true },
    )
    expect(result?.skipped).toEqual([])
    expect(result?.applied).toEqual([
      { external_id: R1, journal_entry_id: E1, via: 'line' },
      { external_id: R2, journal_entry_id: E1, via: 'line' },
    ])
  })
})

describe('matchPairs: one skattekonto event over several verifikat (crm#1183)', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    splitMock.mockReset()
    emitMock.mockResolvedValue(undefined)
  })

  it('hands a 1:N skattekonto pair to the split policy and reports one applied link per verifikat with its slice', async () => {
    const { supabase } = createQueuedMockSupabase()
    splitMock.mockResolvedValue({
      ok: true,
      slices: [
        { journal_entry_id: E1, amount: 37 },
        { journal_entry_id: E2, amount: -8 },
      ],
      primary_journal_entry_id: E1,
      settlement_id: 'set-1',
    })
    const allocations = [
      { journal_entry_id: E1, amount: 37 },
      { journal_entry_id: E2, amount: -8 },
    ]

    const result = await matchPairs(supabase as never, COMPANY, USER, 'skattekonto', {
      pairs: [{ external_ids: [R1], journal_entry_ids: [E1, E2], allocations }],
    })

    expect(splitMock).toHaveBeenCalledWith(supabase, COMPANY, USER, R1, [E1, E2], {
      dryRun: false,
      allocations,
      account: '1630',
    })
    expect(result?.applied).toEqual([
      { external_id: R1, journal_entry_id: E1, via: 'split', allocated_amount: 37 },
      { external_id: R1, journal_entry_id: E2, via: 'split', allocated_amount: -8 },
    ])
    expect(result?.skipped).toEqual([])
    expect(emitMock).toHaveBeenCalledTimes(2)
  })

  it('a dry run passes dryRun through and emits nothing', async () => {
    const { supabase } = createQueuedMockSupabase()
    splitMock.mockResolvedValue({ ok: true, slices: [{ journal_entry_id: E1, amount: 37 }, { journal_entry_id: E2, amount: -8 }], primary_journal_entry_id: E1, settlement_id: null })
    const result = await matchPairs(
      supabase as never,
      COMPANY,
      USER,
      'skattekonto',
      { pairs: [{ external_ids: [R1], journal_entry_ids: [E1, E2] }] },
      { dryRun: true },
    )
    expect(splitMock.mock.calls[0][5]).toEqual({ dryRun: true, account: '1630' })
    expect(result?.applied).toHaveLength(2)
    expect(emitMock).not.toHaveBeenCalled()
  })

  it('reports the split policy\'s refusal as the skip, and refuses allow_remainder on a 1:N pair', async () => {
    const { supabase } = createQueuedMockSupabase()
    splitMock.mockResolvedValue({ ok: false, code: 'PAIR_NOT_CLOSED', message: 'summerar inte' })
    const result = await matchPairs(supabase as never, COMPANY, USER, 'skattekonto', {
      pairs: [
        { external_ids: [R1], journal_entry_ids: [E1, E2] },
        { external_ids: [R2], journal_entry_ids: [E1, E2], allow_remainder: true },
      ],
    })
    expect(result?.applied).toEqual([])
    expect(result?.skipped.map((s) => s.code)).toEqual(['PAIR_NOT_CLOSED', 'UNSUPPORTED_PAIR_SHAPE'])
    expect(splitMock).toHaveBeenCalledTimes(1)
  })
})

describe('unmatchLink / setItemIgnored', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    unlinkMock.mockReset()
    unlinkReconciliationMock.mockReset()
    setIgnoredMock.mockReset()
    junctionLinkedMock.mockReset()
    junctionLinkedMock.mockResolvedValue(new Set<string>())
    undoSettlementMock.mockReset()
    emitMock.mockResolvedValue(undefined)
  })

  it('unlinks a skattekonto row and emits reconciliation.unmatched', async () => {
    const { supabase } = createQueuedMockSupabase()
    unlinkMock.mockResolvedValue({ skattekonto_transaction_id: R1, previous_journal_entry_id: E1 })
    const result = await unmatchLink(supabase as never, COMPANY, USER, 'skattekonto', R1)
    expect(result).toEqual({ external_id: R1, previous_journal_entry_id: E1 })
    expect(emitMock.mock.calls[0][0]).toMatchObject({ type: 'reconciliation.unmatched', payload: { externalId: R1 } })
    // A split's settlement on the verifikat goes with the row link (crm#1183).
    expect(releaseSkvSettlementMock).toHaveBeenCalledWith(supabase, COMPANY, USER, E1)
  })

  it('an id that is no skattekonto row is tried as a 1630 settlement, and refused as before when it is none', async () => {
    const { supabase } = createQueuedMockSupabase()
    unlinkMock.mockRejectedValue(new SkattekontoLinkError('saknas', 'TRANSACTION_NOT_FOUND'))
    undoSkvSettlementMock.mockResolvedValueOnce({ settlement_id: R2, journal_entry_ids: [E1, E2] })
    expect(await unmatchLink(supabase as never, COMPANY, USER, 'skattekonto', R2)).toEqual({
      external_id: R2,
      previous_journal_entry_id: null,
      settlement_id: R2,
      journal_entry_ids: [E1, E2],
    })
    undoSkvSettlementMock.mockResolvedValueOnce(null)
    await expect(unmatchLink(supabase as never, COMPANY, USER, 'skattekonto', R2)).rejects.toMatchObject({
      code: 'TRANSACTION_NOT_FOUND',
    })
  })

  it('unlinks a bank transaction through the bank engine', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { journal_entry_id: E1 } })
    unlinkReconciliationMock.mockResolvedValue({ success: true })
    const result = await unmatchLink(supabase as never, COMPANY, USER, `bank:${CASH}`, R1)
    expect(unlinkReconciliationMock).toHaveBeenCalledWith(supabase, COMPANY, R1, USER)
    expect(result).toEqual({ external_id: R1, previous_journal_entry_id: E1 })
  })

  it('reports the first junction verifikat as previous_journal_entry_id when a split row (no pointer) is unmatched', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { journal_entry_id: null } })
    unlinkReconciliationMock.mockResolvedValue({ success: true, previousJournalEntryIds: [E1, E2] })
    const result = await unmatchLink(supabase as never, COMPANY, USER, `bank:${CASH}`, R1)
    expect(result).toEqual({ external_id: R1, previous_journal_entry_id: E1 })
    expect(emitMock.mock.calls[0][0]).toMatchObject({
      type: 'reconciliation.unmatched',
      payload: { externalId: R1, previousJournalEntryId: E1 },
    })
  })

  it('undoes a ledger-only settlement when the id is no bank transaction of the company (crm#1074)', async () => {
    const SETTLEMENT_ID = '66666666-6666-4666-8666-666666666666'
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null }) // transactions: no such row
    undoSettlementMock.mockResolvedValue({ settlement_id: SETTLEMENT_ID, journal_entry_ids: [E1, E2] })

    const result = await unmatchLink(supabase as never, COMPANY, USER, `bank:${CASH}`, SETTLEMENT_ID)

    expect(undoSettlementMock).toHaveBeenCalledWith(supabase, COMPANY, USER, `bank:${CASH}`, SETTLEMENT_ID)
    expect(result).toEqual({
      external_id: SETTLEMENT_ID,
      previous_journal_entry_id: null,
      settlement_id: SETTLEMENT_ID,
      journal_entry_ids: [E1, E2],
    })
    // No bank row was unlinked, so the bank engine and its event stay out of it.
    expect(unlinkReconciliationMock).not.toHaveBeenCalled()
    expect(emitMock).not.toHaveBeenCalled()
  })

  it('falls through to the bank engine when the id is neither a transaction nor a settlement, and never tries a settlement for a real bank row', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null }) // transactions: no such row
    undoSettlementMock.mockResolvedValue(null)
    unlinkReconciliationMock.mockResolvedValue({ success: false, error: 'Transaktionen kunde inte hittas.' })
    await expect(unmatchLink(supabase as never, COMPANY, USER, `bank:${CASH}`, R1)).rejects.toThrow(
      'Transaktionen kunde inte hittas.',
    )
    expect(unlinkReconciliationMock).toHaveBeenCalledWith(supabase, COMPANY, R1, USER)

    undoSettlementMock.mockClear()
    const linked = createQueuedMockSupabase()
    linked.enqueue({ data: { journal_entry_id: E1 } })
    unlinkReconciliationMock.mockResolvedValue({ success: true })
    await unmatchLink(linked.supabase as never, COMPANY, USER, `bank:${CASH}`, R1)
    expect(undoSettlementMock).not.toHaveBeenCalled()
  })

  it('ignores a skattekonto row via the core helper', async () => {
    const { supabase } = createQueuedMockSupabase()
    setIgnoredMock.mockResolvedValue({ skattekonto_transaction_id: R1, is_ignored: true })
    expect(await setItemIgnored(supabase as never, COMPANY, 'skattekonto', R1, true)).toEqual({
      external_id: R1,
      is_ignored: true,
    })
  })

  // crm#1183: a bank row goes through the one ignore rule the dashboard, v1
  // and MCP doors use, which refuses a row booked through ANY of its three
  // anchors. This door's own copy checked journal_entry_id and voucher links
  // only, so a row booked as a payment allocation (match_batch_allocate)
  // could be ignored while its verifikat still carries it.
  describe('a bank row: the shared ignore rule (crm#1183)', () => {
    const unbookedRow = { data: { id: R1, journal_entry_id: null, is_ignored: false } }

    it.each([
      ['a voucher link (1:N split, bulk-book)', [{ transaction_id: R1 }], [], []],
      ['a customer invoice payment allocation', [], [{ transaction_id: R1 }], []],
      ['a supplier invoice payment allocation', [], [], [{ transaction_id: R1 }]],
    ])('refuses a row booked only through %s, and writes nothing', async (_anchor, links, invoicePayments, supplierPayments) => {
      const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
      enqueue(unbookedRow)
      enqueue({ data: links })
      enqueue({ data: invoicePayments })
      enqueue({ data: supplierPayments })
      await expect(setItemIgnored(supabase as never, COMPANY, `bank:${CASH}`, R1, true, USER)).rejects.toMatchObject({
        code: 'ALREADY_BOOKED',
      })
      expect(findCalls('transactions', 'update')).toEqual([])
    })

    it('refuses a row booked on its journal_entry_id without reading the junctions', async () => {
      const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
      enqueue({ data: { id: R1, journal_entry_id: E1, is_ignored: false } })
      await expect(setItemIgnored(supabase as never, COMPANY, `bank:${CASH}`, R1, true)).rejects.toMatchObject({
        code: 'ALREADY_BOOKED',
      })
      expect(findCalls('transaction_voucher_links', 'select')).toEqual([])
    })

    it('fails closed when an anchor read fails, where the copy read it as unbooked', async () => {
      const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
      enqueue(unbookedRow)
      enqueue({ data: null, error: { message: 'timeout' } })
      enqueue({ data: [] })
      enqueue({ data: [] })
      await expect(setItemIgnored(supabase as never, COMPANY, `bank:${CASH}`, R1, true)).rejects.toBeTruthy()
      expect(findCalls('transactions', 'update')).toEqual([])
    })

    it('reports an unknown row as TRANSACTION_NOT_FOUND', async () => {
      const { supabase, enqueue } = createQueuedMockSupabase()
      enqueue({ data: null })
      await expect(setItemIgnored(supabase as never, COMPANY, `bank:${CASH}`, R1, true)).rejects.toMatchObject({
        code: 'TRANSACTION_NOT_FOUND',
      })
    })

    it('ignores an unbooked row and records the dismissed suggestions with who decided', async () => {
      const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
      const snapshot = { companyId: COMPANY, byTransaction: new Map() }
      snapshotSuggestionsMock.mockResolvedValue(snapshot)
      enqueue(unbookedRow)
      enqueue({ data: [] })
      enqueue({ data: [] })
      enqueue({ data: [] })
      enqueue({ data: null }) // update
      const result = await setItemIgnored(supabase as never, COMPANY, `bank:${CASH}`, R1, true, USER)
      expect(result).toEqual({ external_id: R1, is_ignored: true })
      expect(findCalls('transactions', 'update')[0][0]).toEqual({ is_ignored: true })
      expect(recordDecisionsMock).toHaveBeenCalledWith(
        supabase,
        snapshot,
        [{ transactionId: R1, final: null, checks: [{ id: 'already_booked', result: 'pass', detail: null }] }],
        USER,
      )
    })

    it('restores an ignored row without an anchor check, and is a no-op when already in that state', async () => {
      const restore = createQueuedMockSupabase()
      restore.enqueue({ data: { id: R1, journal_entry_id: null, is_ignored: true } })
      restore.enqueue({ data: null }) // update
      expect(await setItemIgnored(restore.supabase as never, COMPANY, `bank:${CASH}`, R1, false)).toEqual({
        external_id: R1,
        is_ignored: false,
      })
      expect(restore.findCalls('transactions', 'update')[0][0]).toEqual({ is_ignored: false })
      expect(restore.findCalls('transaction_voucher_links', 'select')).toEqual([])

      const same = createQueuedMockSupabase()
      same.enqueue({ data: { id: R1, journal_entry_id: null, is_ignored: true } })
      same.enqueue({ data: [] })
      same.enqueue({ data: [] })
      same.enqueue({ data: [] })
      expect(await setItemIgnored(same.supabase as never, COMPANY, `bank:${CASH}`, R1, true)).toEqual({
        external_id: R1,
        is_ignored: true,
      })
      expect(same.findCalls('transactions', 'update')).toEqual([])
    })
  })
})
