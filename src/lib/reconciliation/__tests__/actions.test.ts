import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'

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
        // 1:N is a bank-only shape (#1553): a skattekonto row never splits.
        { external_ids: [R1], journal_entry_ids: [E1, E2] },
      ],
    })

    expect(result).toMatchObject({ dry_run: false, considered: 4 })
    expect(result?.applied).toEqual([
      { external_id: R1, journal_entry_id: E1, via: 'line' },
      { external_id: R1, journal_entry_id: E2, via: 'entry_total' },
      { external_id: R2, journal_entry_id: E2, via: 'entry_total' },
    ])
    expect(result?.skipped.map((s) => s.code)).toEqual(['ALREADY_LINKED', 'UNSUPPORTED_PAIR_SHAPE'])
    expect(result?.skipped[1].message).toMatch(/skattekontot/)
    expect(linkToVouchersMock).not.toHaveBeenCalled()
    expect(linkGroupMock).toHaveBeenCalledWith(supabase, COMPANY, [R1, R2], E2)
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
    enqueue({ data: [{ id: R1, journal_entry_id: null, is_ignored: false }] }) // skattekonto_transactions
    enqueue({ data: [{ id: E1, status: 'posted', voucher_series: 'A', voucher_number: 7 }] }) // journal_entries
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
    expect(result?.applied).toEqual([{ external_id: R1, journal_entry_id: E1 }])
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
    expect(linkGroupMock).toHaveBeenCalledWith(supabase, COMPANY, [R1, R2], E1)
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

    expect(manualLinkMock).toHaveBeenCalledWith(supabase, COMPANY, R1, E1, USER, '1931')
    expect(result?.applied).toHaveLength(1)
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

describe('unmatchLink / setItemIgnored', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    unlinkMock.mockReset()
    unlinkReconciliationMock.mockReset()
    setIgnoredMock.mockReset()
    junctionLinkedMock.mockReset()
    junctionLinkedMock.mockResolvedValue(new Set<string>())
    emitMock.mockResolvedValue(undefined)
  })

  it('unlinks a skattekonto row and emits reconciliation.unmatched', async () => {
    const { supabase } = createQueuedMockSupabase()
    unlinkMock.mockResolvedValue({ skattekonto_transaction_id: R1, previous_journal_entry_id: E1 })
    const result = await unmatchLink(supabase as never, COMPANY, USER, 'skattekonto', R1)
    expect(result).toEqual({ external_id: R1, previous_journal_entry_id: E1 })
    expect(emitMock.mock.calls[0][0]).toMatchObject({ type: 'reconciliation.unmatched', payload: { externalId: R1 } })
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

  it('refuses to ignore a bank transaction anchored only through transaction_voucher_links (1:N split, bulk-book)', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: R1, journal_entry_id: null, is_ignored: false } })
    junctionLinkedMock.mockResolvedValue(new Set([R1]))
    await expect(setItemIgnored(supabase as never, COMPANY, `bank:${CASH}`, R1, true)).rejects.toMatchObject({
      code: 'ALREADY_BOOKED',
    })
    expect(junctionLinkedMock).toHaveBeenCalledWith(supabase, COMPANY, [R1])
    expect(findCalls('transactions', 'update')).toEqual([])
  })

  it('ignores a skattekonto row via the core helper', async () => {
    const { supabase } = createQueuedMockSupabase()
    setIgnoredMock.mockResolvedValue({ skattekonto_transaction_id: R1, is_ignored: true })
    expect(await setItemIgnored(supabase as never, COMPANY, 'skattekonto', R1, true)).toEqual({
      external_id: R1,
      is_ignored: true,
    })
  })

  it('refuses to ignore a booked bank transaction', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: { id: R1, journal_entry_id: E1, is_ignored: false } })
    await expect(setItemIgnored(supabase as never, COMPANY, `bank:${CASH}`, R1, true)).rejects.toMatchObject({
      code: 'ALREADY_BOOKED',
    })
  })

  it('ignores an unbooked bank transaction', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { id: R1, journal_entry_id: null, is_ignored: false } })
    enqueue({ data: null }) // update
    const result = await setItemIgnored(supabase as never, COMPANY, `bank:${CASH}`, R1, true)
    expect(result).toEqual({ external_id: R1, is_ignored: true })
    expect(findCalls('transactions', 'update')[0][0]).toEqual({ is_ignored: true })
  })
})
