import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'

// The company's skattekonto account (lib/skatteverket/skattekonto-account.ts):
// 1630 here, what every company resolved to before the setting existed.
vi.mock('@/lib/skatteverket/skattekonto-account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/skatteverket/skattekonto-account')>()),
  resolveSkattekontoAccount: vi.fn(async () => '1630'),
}))

// The batch loop delegates all journal writes to the engine: stub the three
// engine entry points so the tests exercise the batch/enrichment logic, not
// the engine's own chains (those are covered by the engine's tests).
vi.mock('@/lib/bookkeeping/engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/bookkeeping/engine')>()
  return {
    ...actual,
    findFiscalPeriod: vi.fn(),
    createDraftEntry: vi.fn(),
    commitEntry: vi.fn(),
  }
})

// The ledger-twin search itself is covered in skattekonto-match-twins.test.ts:
// stub it here so these tests keep exercising the booking flow. Default: no
// twin.
vi.mock('../lib/skattekonto-match', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/skattekonto-match')>()
  return {
    ...actual,
    findLedgerTwinCandidates: vi.fn(),
    findLedgerTwinCandidatesForIds: vi.fn(),
  }
})

// The direct-booking search (a bank verifikat without any 1630 line already
// books the event, PH 171) is covered in skattekonto-direct.test.ts: stub it
// here so these tests keep exercising the booking flow. Default: nothing
// holds any row.
vi.mock('../lib/skattekonto-direct', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/skattekonto-direct')>()
  return { ...actual, findDirectLedgerHolders: vi.fn(), findDirectLedgerHoldersForIds: vi.fn() }
})

// The 1650 balance behind the VAT-refund routing (feedback seq 975032).
// Default: nothing on 1650, so every other test keeps the rule's account.
vi.mock('@/lib/reconciliation/gl-balance', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/reconciliation/gl-balance')>()
  return { ...actual, sumAccountBalance: vi.fn(), findOpeningBalanceFloor: vi.fn() }
})

// The ledger cover (rows a summarised verifikat already holds, crm#1043) is
// the reconciliation bridge's arithmetic, covered in
// skattekonto-reconciliation.test.ts: stub the bridge here so these tests
// keep exercising the booking flow. Default: nothing is covered.
// The ledger plan (rows one verifikat holds, PH 171) rides beside the status:
// stubbed the same way. Default: nothing planned.
vi.mock('@/lib/reconciliation/skattekonto-reconciliation', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/reconciliation/skattekonto-reconciliation')>()
  return { ...actual, getSkattekontoReconciliationStatus: vi.fn(), skattekontoPlannedHolds: vi.fn() }
})

import { findFiscalPeriod, createDraftEntry, commitEntry } from '@/lib/bookkeeping/engine'
import { findOpeningBalanceFloor, sumAccountBalance } from '@/lib/reconciliation/gl-balance'
import {
  getSkattekontoReconciliationStatus,
  skattekontoPlannedHolds,
  type SkattekontoLedgerCover,
  type SkattekontoPlannedHold,
  type SkattekontoReconciliationResult,
} from '@/lib/reconciliation/skattekonto-reconciliation'
import {
  findLedgerTwinCandidates,
  findLedgerTwinCandidatesForIds,
  type SkattekontoMatchCandidate,
} from '../lib/skattekonto-match'
import { getBASReference } from '@/lib/bookkeeping/bas-reference'
import { findDirectLedgerHolders, findDirectLedgerHoldersForIds } from '../lib/skattekonto-direct'
import {
  attachBookingSuggestions,
  bokforSkattekontoTransaction,
  bokforSkattekontoTransactionsBatch,
  buildSkattekontoEntry,
  counterLineOf,
  ledgerCoverMessage,
  ledgerDirectMessage,
  ledgerHoldOf,
  ledgerHoldOfRows,
  SkattekontoBookingError,
  toLedgerCoverInfo,
  type SkattekontoLedgerHolding,
} from '../lib/skattekonto-booking'

/**
 * System seeds mirror supabase/migrations/20260519100000_skattekonto_rules.sql
 * (same fixture as skattekonto-booking.test.ts).
 */
const SEED_RULES = [
  {
    id: 'sys-1', priority: 10, pattern: 'inbetalning bokförd,inbetalning,överföring från bank',
    amount_min: null, amount_max: null, company_type: 'all',
    counter_account: '__PRIMARY_SEK__', counter_account_ef: null,
    label: 'Inbetalning till skattekonto', active: true,
  },
  {
    id: 'sys-3', priority: 20, pattern: 'debiterad preliminärskatt,preliminärskatt,f-skatt,fskatt',
    amount_min: null, amount_max: null, company_type: 'all',
    counter_account: '2510', counter_account_ef: '2013',
    label: 'Preliminär skatt', active: true,
  },
  {
    id: 'sys-8', priority: 30, pattern: 'kostnadsränta',
    amount_min: null, amount_max: null, company_type: 'all',
    counter_account: '8423', counter_account_ef: null,
    label: 'Kostnadsränta skattekonto', active: true,
  },
  {
    id: 'sys-9', priority: 30, pattern: 'intäktsränta',
    amount_min: null, amount_max: null, company_type: 'all',
    counter_account: '8314', counter_account_ef: null,
    label: 'Intäktsränta skattekonto', active: true,
  },
]

let rowSeq = 0
function makeSkvRow(overrides: Record<string, unknown> = {}) {
  rowSeq += 1
  return {
    id: `row-${rowSeq}`,
    company_id: 'company-1',
    transaktionstext: 'Intäktsränta',
    transaktionsdatum: '2026-01-15',
    belopp_skatteverket: 1,
    status: 'booked',
    journal_entry_id: null,
    ...overrides,
  }
}

function makeSupabase() {
  return createQueuedMockSupabase()
}

/** Number of times a table was targeted by supabase.from(). */
function fromCount(
  supabase: ReturnType<typeof makeSupabase>['supabase'],
  table: string,
): number {
  return supabase.from.mock.calls.filter((c: unknown[]) => c[0] === table).length
}

beforeEach(() => {
  vi.clearAllMocks()
  rowSeq = 0
  vi.mocked(findFiscalPeriod).mockResolvedValue('fp-1')
  vi.mocked(createDraftEntry).mockImplementation(async () =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ({ id: 'je-draft-1' }) as any,
  )
  vi.mocked(commitEntry).mockImplementation(async () =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ({ id: 'je-draft-1', voucher_number: 42, voucher_series: 'A' }) as any,
  )
  vi.mocked(findLedgerTwinCandidates).mockImplementation(
    async (_supabase, _companyId, probes) => new Map(probes.map((p) => [p.id, []])),
  )
  vi.mocked(findLedgerTwinCandidatesForIds).mockImplementation(
    async (_supabase, _companyId, ids) => new Map(ids.map((id) => [id, []])),
  )
  vi.mocked(sumAccountBalance).mockResolvedValue(0)
  vi.mocked(findOpeningBalanceFloor).mockResolvedValue(null)
  vi.mocked(findDirectLedgerHolders).mockImplementation(
    async (_supabase, _companyId, probes) => new Map(probes.map((p) => [p.id, []])),
  )
  vi.mocked(findDirectLedgerHoldersForIds).mockResolvedValue(new Map())
  bridgeCover(null)
  bridgePlanned([])
})

/** What the reconciliation bridge answers for the company: the rows a summarised verifikat covers, or none. */
function bridgeCover(cover: SkattekontoLedgerCover | null, ledgerReadFailed = false) {
  vi.mocked(getSkattekontoReconciliationStatus).mockResolvedValue({
    account_number: '1630',
    ledger_read_failed: ledgerReadFailed,
    cover,
  } as unknown as SkattekontoReconciliationResult)
}

/** The ledger plan beside the status: these rows held by one monthly verifikat (B7, 28 February). */
function bridgePlanned(rowIds: string[], total = -5100) {
  const hold: SkattekontoPlannedHold = {
    entry: {
      journal_entry_id: 'je-february',
      voucher_number: 7,
      voucher_series: 'B',
      entry_date: '2027-02-28',
      description: 'Skattekonto februari',
      status: 'posted',
      open_amount: total,
    },
    event_ids: rowIds,
    total,
    from_date: '2027-02-28',
    to_date: '2027-03-26',
  }
  vi.mocked(skattekontoPlannedHolds).mockReturnValue(new Map(rowIds.map((id) => [id, hold])))
}

const REASON = 'Räntan debiterades två gånger av Skatteverket'

/** The notes of the n-th drafted verifikat. */
function draftedNotes(n = 0): string | undefined {
  return (vi.mocked(createDraftEntry).mock.calls[n]?.[3] as { notes?: string } | undefined)?.notes
}

describe('attachBookingSuggestions', () => {
  it('attaches account, BAS name and rule label on a rule match', async () => {
    const { supabase, enqueue } = makeSupabase()
    enqueue({ data: SEED_RULES }) // skattekonto_rules
    enqueue({ data: { entity_type: 'aktiebolag' } }) // company_settings

    const rows = [makeSkvRow({ transaktionstext: 'Intäktsränta' })]
    const enriched = await attachBookingSuggestions(
      supabase as unknown as SupabaseClient,
      'company-1',
      rows,
    )

    expect(enriched[0].booking_suggestion).toEqual({
      account: '8314',
      account_name: getBASReference('8314')?.account_name ?? null,
      label: 'Intäktsränta skattekonto',
    })
  })

  it('resolves EF-specific counter accounts from the hoisted entity_type', async () => {
    const { supabase, enqueue } = makeSupabase()
    enqueue({ data: SEED_RULES })
    enqueue({ data: { entity_type: 'enskild_firma' } })

    const enriched = await attachBookingSuggestions(
      supabase as unknown as SupabaseClient,
      'company-1',
      [makeSkvRow({ transaktionstext: 'Debiterad preliminärskatt' })],
    )
    expect(enriched[0].booking_suggestion?.account).toBe('2013')

    const ab = makeSupabase()
    ab.enqueue({ data: SEED_RULES })
    ab.enqueue({ data: { entity_type: 'aktiebolag' } })
    const enrichedAb = await attachBookingSuggestions(
      ab.supabase as unknown as SupabaseClient,
      'company-1',
      [makeSkvRow({ transaktionstext: 'Debiterad preliminärskatt' })],
    )
    expect(enrichedAb[0].booking_suggestion?.account).toBe('2510')
  })

  it('returns null when no rule matches', async () => {
    const { supabase, enqueue } = makeSupabase()
    enqueue({ data: SEED_RULES })
    enqueue({ data: { entity_type: 'aktiebolag' } })

    const enriched = await attachBookingSuggestions(
      supabase as unknown as SupabaseClient,
      'company-1',
      [makeSkvRow({ transaktionstext: 'Något helt okänt' })],
    )
    expect(enriched[0].booking_suggestion).toBeNull()
  })

  it('gates a requires_employer rule for a non-employer EF and marks booking_gate', async () => {
    const AVDRAGEN_RULE = [
      {
        id: 'sys-5', priority: 20, pattern: 'avdragen skatt,personalskatt,a-skatt',
        amount_min: null, amount_max: null, company_type: 'all',
        counter_account: '2710', counter_account_ef: null,
        label: 'Avdragen skatt anställda', active: true, requires_employer: true,
      },
    ]

    // EF, not employer_registered: no suggestion, distinct gate marker.
    const ef = makeSupabase()
    ef.enqueue({ data: AVDRAGEN_RULE })
    ef.enqueue({ data: { entity_type: 'enskild_firma', employer_registered: null } })
    const gated = await attachBookingSuggestions(
      ef.supabase as unknown as SupabaseClient,
      'company-1',
      [makeSkvRow({ transaktionstext: 'Avdragen skatt' })],
    )
    expect(gated[0].booking_suggestion).toBeNull()
    expect(gated[0].booking_gate).toBe('requires_employer')

    // EF that runs payroll keeps 2710, with no gate marker.
    const employer = makeSupabase()
    employer.enqueue({ data: AVDRAGEN_RULE })
    employer.enqueue({ data: { entity_type: 'enskild_firma', employer_registered: true } })
    const kept = await attachBookingSuggestions(
      employer.supabase as unknown as SupabaseClient,
      'company-1',
      [makeSkvRow({ transaktionstext: 'Avdragen skatt' })],
    )
    expect(kept[0].booking_suggestion?.account).toBe('2710')
    expect(kept[0].booking_gate).toBeUndefined()

    // AB is never gated.
    const ab = makeSupabase()
    ab.enqueue({ data: AVDRAGEN_RULE })
    ab.enqueue({ data: { entity_type: 'aktiebolag', employer_registered: null } })
    const abRows = await attachBookingSuggestions(
      ab.supabase as unknown as SupabaseClient,
      'company-1',
      [makeSkvRow({ transaktionstext: 'Avdragen skatt' })],
    )
    expect(abRows[0].booking_suggestion?.account).toBe('2710')
  })

  it('falls back to pays_salaries when employer_registered was never attested', async () => {
    const AVDRAGEN_RULE = [
      {
        id: 'sys-5', priority: 20, pattern: 'avdragen skatt,personalskatt,a-skatt',
        amount_min: null, amount_max: null, company_type: 'all',
        counter_account: '2710', counter_account_ef: null,
        label: 'Avdragen skatt anställda', active: true, requires_employer: true,
      },
    ]

    // Same signal as lib/tax/deadline-config.ts: an EF that answered
    // pays_salaries in onboarding but never attested employer_registered
    // (null) still runs payroll, so the gate opens and 2710 stays.
    const ef = makeSupabase()
    ef.enqueue({ data: AVDRAGEN_RULE })
    ef.enqueue({
      data: { entity_type: 'enskild_firma', employer_registered: null, pays_salaries: true },
    })
    const kept = await attachBookingSuggestions(
      ef.supabase as unknown as SupabaseClient,
      'company-1',
      [makeSkvRow({ transaktionstext: 'Avdragen skatt' })],
    )
    expect(kept[0].booking_suggestion?.account).toBe('2710')
    expect(kept[0].booking_gate).toBeUndefined()

    // An explicit employer_registered = false wins over pays_salaries: the
    // attestation is the stronger, later signal, so the gate stays closed.
    const attested = makeSupabase()
    attested.enqueue({ data: AVDRAGEN_RULE })
    attested.enqueue({
      data: { entity_type: 'enskild_firma', employer_registered: false, pays_salaries: true },
    })
    const gated = await attachBookingSuggestions(
      attested.supabase as unknown as SupabaseClient,
      'company-1',
      [makeSkvRow({ transaktionstext: 'Avdragen skatt' })],
    )
    expect(gated[0].booking_suggestion).toBeNull()
    expect(gated[0].booking_gate).toBe('requires_employer')
  })

  it('hoists the rules fetch: one skattekonto_rules query for many rows', async () => {
    const { supabase, enqueue } = makeSupabase()
    enqueue({ data: SEED_RULES })
    enqueue({ data: { entity_type: 'aktiebolag' } })

    const rows = [
      makeSkvRow({ transaktionstext: 'Intäktsränta' }),
      makeSkvRow({ transaktionstext: 'Kostnadsränta' }),
      makeSkvRow({ transaktionstext: 'Debiterad preliminärskatt' }),
    ]
    const enriched = await attachBookingSuggestions(
      supabase as unknown as SupabaseClient,
      'company-1',
      rows,
    )

    expect(enriched.map((r) => r.booking_suggestion?.account)).toEqual([
      '8314',
      '8423',
      '2510',
    ])
    expect(fromCount(supabase, 'skattekonto_rules')).toBe(1)
    expect(fromCount(supabase, 'company_settings')).toBe(1)
  })

  it('resolves the __PRIMARY_SEK__ sentinel once via cash_accounts', async () => {
    const { supabase, enqueue } = makeSupabase()
    enqueue({ data: SEED_RULES })
    enqueue({ data: { entity_type: 'aktiebolag' } })
    enqueue({ data: { ledger_account: '1932', enabled: true, currency: 'SEK' } }) // cash_accounts primary

    const rows = [
      makeSkvRow({ transaktionstext: 'Inbetalning bokförd 240412' }),
      makeSkvRow({ transaktionstext: 'Inbetalning bokförd 240513' }),
    ]
    const enriched = await attachBookingSuggestions(
      supabase as unknown as SupabaseClient,
      'company-1',
      rows,
    )

    expect(enriched[0].booking_suggestion?.account).toBe('1932')
    expect(enriched[1].booking_suggestion?.account).toBe('1932')
    // Memoized: the second sentinel row must not refetch cash_accounts.
    expect(fromCount(supabase, 'cash_accounts')).toBe(1)
  })

  it('gives booked rows null without any fetches when nothing needs a suggestion', async () => {
    const { supabase } = makeSupabase()
    const enriched = await attachBookingSuggestions(
      supabase as unknown as SupabaseClient,
      'company-1',
      [makeSkvRow({ journal_entry_id: 'je-9' }), makeSkvRow({ status: 'upcoming' })],
    )
    expect(enriched.every((r) => r.booking_suggestion === null)).toBe(true)
    expect(supabase.from).not.toHaveBeenCalled()
  })
})

describe('bokforSkattekontoTransactionsBatch', () => {
  it('books each row, commits per row, and never aborts on a row failure', async () => {
    const { supabase, enqueue } = makeSupabase()
    const row1 = makeSkvRow({ transaktionstext: 'Intäktsränta' })
    const row2 = makeSkvRow({ transaktionstext: 'Ingen regel matchar detta' })
    const row3 = makeSkvRow({ transaktionstext: 'Kostnadsränta', belopp_skatteverket: -100 })

    enqueue({ data: SEED_RULES }) // hoisted rules
    enqueue({ data: { entity_type: 'aktiebolag' } }) // hoisted entity_type
    enqueue({ data: row1 }) // tx fetch row1
    enqueue({ data: [{ id: row1.id }] }) // journal_entry_id claim row1
    enqueue({ data: row2 }) // tx fetch row2 (fails matching, no claim)
    enqueue({ data: row3 }) // tx fetch row3
    enqueue({ data: [{ id: row3.id }] }) // claim row3

    const result = await bokforSkattekontoTransactionsBatch(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      [row1.id, row2.id, row3.id],
    )

    expect(result.results).toHaveLength(3)
    expect(result.results[0]).toMatchObject({
      id: row1.id,
      ok: true,
      journal_entry_id: 'je-draft-1',
      voucher_number: 42,
      voucher_series: 'A',
    })
    expect(result.results[1]).toMatchObject({
      id: row2.id,
      ok: false,
      error_code: 'NO_COUNTER_ACCOUNT',
    })
    expect(result.results[2]).toMatchObject({ id: row3.id, ok: true })
    expect(result.summary).toEqual({ total: 3, succeeded: 2, failed: 1 })

    // Commit runs once per successful row, attributed as a bulk acceptance.
    expect(vi.mocked(commitEntry)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(commitEntry)).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      'je-draft-1',
      'bulk_accept',
    )
    expect(vi.mocked(createDraftEntry)).toHaveBeenCalledTimes(2)
  })

  it('hoists rules/entity_type: one fetch each for the whole batch', async () => {
    const { supabase, enqueue } = makeSupabase()
    const row1 = makeSkvRow({ transaktionstext: 'Intäktsränta' })
    const row2 = makeSkvRow({ transaktionstext: 'Kostnadsränta' })

    enqueue({ data: SEED_RULES })
    enqueue({ data: { entity_type: 'aktiebolag' } })
    enqueue({ data: row1 })
    enqueue({ data: [{ id: row1.id }] })
    enqueue({ data: row2 })
    enqueue({ data: [{ id: row2.id }] })

    await bokforSkattekontoTransactionsBatch(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      [row1.id, row2.id],
    )

    expect(fromCount(supabase, 'skattekonto_rules')).toBe(1)
    expect(fromCount(supabase, 'company_settings')).toBe(1)
  })

  it('attributes a one-row batch as user_accept', async () => {
    const { supabase, enqueue } = makeSupabase()
    const row = makeSkvRow({ transaktionstext: 'Intäktsränta' })
    enqueue({ data: SEED_RULES })
    enqueue({ data: { entity_type: 'aktiebolag' } })
    enqueue({ data: row })
    enqueue({ data: [{ id: row.id }] })

    await bokforSkattekontoTransactionsBatch(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      [row.id],
    )

    expect(vi.mocked(commitEntry)).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      'user-1',
      'je-draft-1',
      'user_accept',
    )
  })

  it('reports COMMIT_FAILED with the kept draft id when the commit throws', async () => {
    const { supabase, enqueue } = makeSupabase()
    const row = makeSkvRow({ transaktionstext: 'Intäktsränta' })
    enqueue({ data: SEED_RULES })
    enqueue({ data: { entity_type: 'aktiebolag' } })
    enqueue({ data: row })
    enqueue({ data: [{ id: row.id }] })

    vi.mocked(commitEntry).mockRejectedValueOnce(new Error('Bokföringen är låst'))

    const result = await bokforSkattekontoTransactionsBatch(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      [row.id],
    )

    expect(result.results[0]).toMatchObject({
      id: row.id,
      ok: false,
      error_code: 'COMMIT_FAILED',
      journal_entry_id: 'je-draft-1',
      error_message: 'Bokföringen är låst',
    })
    expect(result.summary).toEqual({ total: 1, succeeded: 0, failed: 1 })
  })

  it('reports ALREADY_BOOKED for rows that already carry a journal entry', async () => {
    const { supabase, enqueue } = makeSupabase()
    const row = makeSkvRow({ journal_entry_id: 'je-existing' })
    enqueue({ data: SEED_RULES })
    enqueue({ data: { entity_type: 'aktiebolag' } })
    enqueue({ data: row })

    const result = await bokforSkattekontoTransactionsBatch(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      [row.id],
    )

    expect(result.results[0]).toMatchObject({
      id: row.id,
      ok: false,
      error_code: 'ALREADY_BOOKED',
    })
    expect(vi.mocked(createDraftEntry)).not.toHaveBeenCalled()
    expect(vi.mocked(commitEntry)).not.toHaveBeenCalled()
  })

  it('rejects unsettled (kommande) rows with NOT_SETTLED before any draft exists', async () => {
    const { supabase, enqueue } = makeSupabase()
    // Rule WOULD match: only status must stop the row from being posted.
    const row = makeSkvRow({ transaktionstext: 'Intäktsränta', status: 'upcoming' })
    enqueue({ data: SEED_RULES })
    enqueue({ data: { entity_type: 'aktiebolag' } })
    enqueue({ data: row })

    const result = await bokforSkattekontoTransactionsBatch(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      [row.id],
    )

    expect(result.results[0]).toMatchObject({
      id: row.id,
      ok: false,
      error_code: 'NOT_SETTLED',
    })
    expect(result.summary).toEqual({ total: 1, succeeded: 0, failed: 1 })
    expect(vi.mocked(createDraftEntry)).not.toHaveBeenCalled()
    expect(vi.mocked(commitEntry)).not.toHaveBeenCalled()
  })

  it('reports ALREADY_BOOKED and never commits when the backlink claim affects 0 rows', async () => {
    const { supabase, enqueue } = makeSupabase()
    const row = makeSkvRow({ transaktionstext: 'Intäktsränta' })
    enqueue({ data: SEED_RULES })
    enqueue({ data: { entity_type: 'aktiebolag' } })
    enqueue({ data: row }) // tx fetch: still unbooked at precheck time
    enqueue({ data: [] }) // claim: a concurrent submission won the race

    const result = await bokforSkattekontoTransactionsBatch(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      [row.id],
    )

    expect(result.results[0]).toMatchObject({
      id: row.id,
      ok: false,
      error_code: 'ALREADY_BOOKED',
    })
    // The draft was created before the claim, but the losing request must
    // never post it: no voucher may be committed for a row someone else owns.
    expect(vi.mocked(createDraftEntry)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(commitEntry)).not.toHaveBeenCalled()
  })

  it('maps the period-lock trigger error to PERIOD_LOCKED with Swedish text', async () => {
    const { supabase, enqueue } = makeSupabase()
    const row = makeSkvRow({ transaktionstext: 'Intäktsränta' })
    enqueue({ data: SEED_RULES })
    enqueue({ data: { entity_type: 'aktiebolag' } })
    enqueue({ data: row })

    // A locked-but-not-closed period passes findFiscalPeriod's is_closed
    // precheck; the enforcement trigger then rejects the draft INSERT with
    // this signature (wrapped by the engine's BookkeepingDatabaseError).
    vi.mocked(createDraftEntry).mockRejectedValueOnce(
      new Error(
        'Database operation "create_draft_entry" failed: Cannot write to locked/closed fiscal period "2026" (is_closed=f, locked_at=2026-02-01 00:00:00+00)',
      ),
    )

    const result = await bokforSkattekontoTransactionsBatch(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      [row.id],
    )

    expect(result.results[0]).toMatchObject({
      id: row.id,
      ok: false,
      error_code: 'PERIOD_LOCKED',
    })
    expect(result.results[0].error_message).not.toContain('locked/closed fiscal period')
    expect(vi.mocked(commitEntry)).not.toHaveBeenCalled()
  })

  it('explains a row that predates the first fiscal year instead of "unlock the period"', async () => {
    const { supabase, enqueue } = makeSupabase()
    // Typical EF case: the personal skattekonto carries history from before
    // the company existed. No period covers the date and none ever will, so
    // "lås upp perioden" is a dead end; the message must point at ignore.
    const row = makeSkvRow({
      transaktionstext: 'Intäktsränta',
      transaktionsdatum: '2025-04-12',
    })
    enqueue({ data: SEED_RULES })
    enqueue({ data: { entity_type: 'enskild_firma' } })
    enqueue({ data: row })
    enqueue({ data: [{ period_start: '2025-11-01' }] }) // earliest fiscal period

    vi.mocked(findFiscalPeriod).mockResolvedValue(null)

    const result = await bokforSkattekontoTransactionsBatch(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      [row.id],
    )

    expect(result.results[0]).toMatchObject({
      id: row.id,
      ok: false,
      error_code: 'PERIOD_LOCKED',
    })
    expect(result.results[0].error_message).toContain('före företagets första räkenskapsår')
    expect(result.results[0].error_message).toContain('kan ignoreras')
    expect(vi.mocked(createDraftEntry)).not.toHaveBeenCalled()
  })

  it('rejects an ignored row with ROW_IGNORED before any draft exists', async () => {
    const { supabase, enqueue } = makeSupabase()
    // Rule WOULD match: only the user's explicit ignore stops the booking.
    const row = makeSkvRow({ transaktionstext: 'Intäktsränta', is_ignored: true })
    enqueue({ data: SEED_RULES })
    enqueue({ data: { entity_type: 'aktiebolag' } })
    enqueue({ data: row })

    const result = await bokforSkattekontoTransactionsBatch(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      [row.id],
    )

    expect(result.results[0]).toMatchObject({
      id: row.id,
      ok: false,
      error_code: 'ROW_IGNORED',
      error_message: 'Transaktionen är ignorerad. Återställ den innan du bokför.',
    })
    expect(result.summary).toEqual({ total: 1, succeeded: 0, failed: 1 })
    // The gate fires before the engine is touched: no orphan draft.
    expect(vi.mocked(createDraftEntry)).not.toHaveBeenCalled()
    expect(vi.mocked(commitEntry)).not.toHaveBeenCalled()
  })
  it('maps the live-unique index violation to ALREADY_BOOKED: the losing Bokför never claims or commits', async () => {
    const { supabase, enqueue } = makeSupabase()
    const row = makeSkvRow({ transaktionstext: 'Intäktsränta' })
    enqueue({ data: SEED_RULES })
    enqueue({ data: { entity_type: 'aktiebolag' } })
    enqueue({ data: row }) // tx fetch: still unbooked at precheck time

    // journal_entries_system_source_live_unique (migration 20260920145033)
    // refuses the second live 'system' entry for this row at the draft
    // INSERT; the engine wraps the 23505 in BookkeepingDatabaseError.
    vi.mocked(createDraftEntry).mockRejectedValueOnce(
      new Error(
        'Database operation "create_draft_entry" failed: duplicate key value violates unique constraint "journal_entries_system_source_live_unique"',
      ),
    )

    const result = await bokforSkattekontoTransactionsBatch(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      [row.id],
    )

    expect(result.results[0]).toMatchObject({
      id: row.id,
      ok: false,
      error_code: 'ALREADY_BOOKED',
      error_message: 'Transaktionen är redan bokförd.',
    })
    expect(result.summary).toEqual({ total: 1, succeeded: 0, failed: 1 })
    // The loser has no draft, so there is nothing to claim and nothing to
    // commit: the only skattekonto_transactions access is the precheck fetch.
    expect(fromCount(supabase, 'skattekonto_transactions')).toBe(1)
    expect(vi.mocked(commitEntry)).not.toHaveBeenCalled()
  })

  it('leaves other draft-insert failures unmapped (UNKNOWN), so only our index reads as ALREADY_BOOKED', async () => {
    const { supabase, enqueue } = makeSupabase()
    const row = makeSkvRow({ transaktionstext: 'Intäktsränta' })
    enqueue({ data: SEED_RULES })
    enqueue({ data: { entity_type: 'aktiebolag' } })
    enqueue({ data: row })

    vi.mocked(createDraftEntry).mockRejectedValueOnce(
      new Error(
        'Database operation "create_draft_entry" failed: duplicate key value violates unique constraint "journal_entries_rot_rut_payout_live_unique"',
      ),
    )

    const result = await bokforSkattekontoTransactionsBatch(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      [row.id],
    )

    expect(result.results[0]).toMatchObject({ id: row.id, ok: false, error_code: 'UNKNOWN' })
    expect(vi.mocked(commitEntry)).not.toHaveBeenCalled()
  })
})

describe('bokforSkattekontoTransaction (single row)', () => {
  it('throws ALREADY_BOOKED with the precheck message when the live-unique index refuses the draft', async () => {
    const { supabase, enqueue } = makeSupabase()
    const row = makeSkvRow({ transaktionstext: 'Intäktsränta' })
    enqueue({ data: row }) // tx fetch
    enqueue({ data: SEED_RULES })
    enqueue({ data: { entity_type: 'aktiebolag' } })

    vi.mocked(createDraftEntry).mockRejectedValueOnce(
      new Error(
        'Database operation "create_draft_entry" failed: duplicate key value violates unique constraint "journal_entries_system_source_live_unique"',
      ),
    )

    const err = await bokforSkattekontoTransaction(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      row.id,
    ).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(SkattekontoBookingError)
    expect((err as SkattekontoBookingError).code).toBe('ALREADY_BOOKED')
    expect((err as SkattekontoBookingError).message).toBe('Transaktionen är redan bokförd.')
    // No claim attempted: the row was only read.
    expect(fromCount(supabase, 'skattekonto_transactions')).toBe(1)
  })
})

/** An imported 1630 verifikat carrying the same event (a twin). */
function twinCandidate(overrides: Partial<SkattekontoMatchCandidate> = {}): SkattekontoMatchCandidate {
  return {
    journal_entry_id: 'je-imported-185',
    voucher_number: 185,
    voucher_series: 'A',
    entry_date: '2026-01-15',
    description: 'Intäktsränta (import)',
    status: 'posted',
    matched_amount: 1,
    matched_side: 'debit',
    matched_via_agi_period: false,
    ...overrides,
  }
}

describe('ledger twin guard (an SIE-imported or manual verifikat already carries the event)', () => {
  it('refuses a single row with LEDGER_TWIN_EXISTS before any rule, period or draft work', async () => {
    const { supabase, enqueue } = makeSupabase()
    const row = makeSkvRow({ transaktionstext: 'Intäktsränta' })
    enqueue({ data: row }) // tx fetch
    vi.mocked(findLedgerTwinCandidates).mockResolvedValueOnce(new Map([[row.id, [twinCandidate()]]]))

    const err = await bokforSkattekontoTransaction(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      row.id,
    ).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(SkattekontoBookingError)
    const refusal = err as SkattekontoBookingError
    expect(refusal.code).toBe('LEDGER_TWIN_EXISTS')
    expect(refusal.message).toContain('verifikat A185 (2026-01-15)')
    expect(refusal.message).toContain('Koppla raden')
    expect(refusal.ledgerTwins).toEqual([
      {
        journal_entry_id: 'je-imported-185',
        voucher_series: 'A',
        voucher_number: 185,
        entry_date: '2026-01-15',
        description: 'Intäktsränta (import)',
        status: 'posted',
      },
    ])
    // The search ran for exactly this row.
    expect(vi.mocked(findLedgerTwinCandidates).mock.calls[0][2]).toEqual([row])
    expect(vi.mocked(findFiscalPeriod)).not.toHaveBeenCalled()
    expect(vi.mocked(createDraftEntry)).not.toHaveBeenCalled()
    // Only the row itself was read: no rules fetch, no claim.
    expect(fromCount(supabase, 'skattekonto_rules')).toBe(0)
  })

  it('tells an unsettled (kommande) row to wait and link later: Koppla refuses it until Skatteverket settles it', async () => {
    const { supabase, enqueue } = makeSupabase()
    // The single-row draft path opens kommande rows (requireSettled off).
    const row = makeSkvRow({ transaktionstext: 'Debiterad preliminärskatt', belopp_skatteverket: -4000, status: 'upcoming', transaktionsdatum: '2026-10-12' })
    enqueue({ data: row })
    vi.mocked(findLedgerTwinCandidates).mockResolvedValueOnce(
      new Map([[row.id, [twinCandidate({ entry_date: '2026-10-01', matched_amount: 4000, matched_side: 'credit' })]]]),
    )

    const err = await bokforSkattekontoTransaction(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      row.id,
    ).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(SkattekontoBookingError)
    const refusal = err as SkattekontoBookingError
    expect(refusal.code).toBe('LEDGER_TWIN_EXISTS')
    expect(refusal.message).toContain('verifikat A185 (2026-10-01)')
    expect(refusal.message).toContain('Skatteverket har inte genomfört händelsen ännu')
    expect(refusal.message).toContain('vänta tills den är genomförd och koppla då raden till det')
    expect(vi.mocked(createDraftEntry)).not.toHaveBeenCalled()
  })

  it('names the companion rows of a combined twin: the verifikat carries the event only together with them', async () => {
    const { supabase, enqueue } = makeSupabase()
    const row = makeSkvRow({ transaktionstext: 'Avdragen skatt', belopp_skatteverket: -3000 })
    enqueue({ data: row })
    const combined = twinCandidate({
      matched_amount: 3000,
      matched_side: 'credit',
      combined_with: [
        { id: 'row-agavg', transaktionsdatum: '2026-01-15', transaktionstext: 'Arbetsgivaravgift', belopp_skatteverket: -4000 },
      ],
      combined_total: 7000,
    })
    vi.mocked(findLedgerTwinCandidates).mockResolvedValueOnce(new Map([[row.id, [combined]]]))

    const err = (await bokforSkattekontoTransaction(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      row.id,
    ).catch((e: unknown) => e)) as SkattekontoBookingError

    expect(err.code).toBe('LEDGER_TWIN_EXISTS')
    expect(err.message).toContain('Koppla raden till det tillsammans med en annan rad på skattekontot')
    expect(err.ledgerTwins?.[0].combined_with?.map((c) => c.id)).toEqual(['row-agavg'])
  })

  it('books a twin row on the override with a reason, and the verifikat notes what it booked over and why', async () => {
    const { supabase, enqueue } = makeSupabase()
    const row = makeSkvRow({ transaktionstext: 'Intäktsränta' })
    enqueue({ data: row })
    enqueue({ data: SEED_RULES })
    enqueue({ data: { entity_type: 'aktiebolag' } })
    enqueue({ data: [{ id: row.id }] }) // claim
    vi.mocked(findLedgerTwinCandidates).mockResolvedValueOnce(new Map([[row.id, [twinCandidate()]]]))

    const entry = await bokforSkattekontoTransaction(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      row.id,
      undefined,
      { duplicateReason: `  ${REASON}  ` },
    )

    expect(entry.id).toBe('je-draft-1')
    expect(vi.mocked(createDraftEntry)).toHaveBeenCalledTimes(1)
    expect(draftedNotes()).toContain('Genererad från skattekonto-synk.')
    expect(draftedNotes()).toContain(`Bokförd trots att bokföringen redan innehåller händelsen (A185). Skäl: ${REASON}`)
  })

  it('an override without a reason is no override: the twin still refuses', async () => {
    const { supabase, enqueue } = makeSupabase()
    const row = makeSkvRow({ transaktionstext: 'Intäktsränta' })
    enqueue({ data: row })
    vi.mocked(findLedgerTwinCandidates).mockResolvedValueOnce(new Map([[row.id, [twinCandidate()]]]))

    await expect(
      bokforSkattekontoTransaction(supabase as unknown as SupabaseClient, 'company-1', 'user-1', row.id, undefined, {
        duplicateReason: '   ',
      }),
    ).rejects.toMatchObject({ code: 'LEDGER_TWIN_EXISTS' })
    expect(vi.mocked(createDraftEntry)).not.toHaveBeenCalled()
  })

  it('a reason on a row the ledger does not hold changes nothing: no note', async () => {
    const { supabase, enqueue } = makeSupabase()
    const row = makeSkvRow({ transaktionstext: 'Intäktsränta' })
    enqueue({ data: row })
    enqueue({ data: SEED_RULES })
    enqueue({ data: { entity_type: 'aktiebolag' } })
    enqueue({ data: [{ id: row.id }] })

    await bokforSkattekontoTransaction(supabase as unknown as SupabaseClient, 'company-1', 'user-1', row.id, undefined, {
      duplicateReason: REASON,
    })
    expect(draftedNotes()).not.toContain('Bokförd trots')
  })

  it('books a row with no twin unchanged', async () => {
    const { supabase, enqueue } = makeSupabase()
    const row = makeSkvRow({ transaktionstext: 'Intäktsränta' })
    enqueue({ data: row })
    enqueue({ data: SEED_RULES })
    enqueue({ data: { entity_type: 'aktiebolag' } })
    enqueue({ data: [{ id: row.id }] })

    const entry = await bokforSkattekontoTransaction(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      row.id,
    )

    expect(entry.id).toBe('je-draft-1')
    expect(vi.mocked(findLedgerTwinCandidates)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(createDraftEntry)).toHaveBeenCalledTimes(1)
  })

  it('batch: searches once for all rows, skips the twin with its code and twins, books the rest', async () => {
    const { supabase, enqueue } = makeSupabase()
    const twinRow = makeSkvRow({ transaktionstext: 'Kostnadsränta', belopp_skatteverket: -1 })
    const cleanRow = makeSkvRow({ transaktionstext: 'Intäktsränta' })
    vi.mocked(findLedgerTwinCandidatesForIds).mockResolvedValueOnce(
      new Map([
        [twinRow.id, [twinCandidate({ matched_side: 'credit' }), twinCandidate({ journal_entry_id: 'je-imported-186', voucher_number: 186, entry_date: '2026-01-17' })]],
        [cleanRow.id, []],
      ]),
    )

    enqueue({ data: SEED_RULES })
    enqueue({ data: { entity_type: 'aktiebolag' } })
    enqueue({ data: twinRow }) // tx fetch twin row: refused before rules/claim
    enqueue({ data: cleanRow }) // tx fetch clean row
    enqueue({ data: [{ id: cleanRow.id }] }) // claim clean row

    const result = await bokforSkattekontoTransactionsBatch(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      [twinRow.id, cleanRow.id],
    )

    expect(vi.mocked(findLedgerTwinCandidatesForIds)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(findLedgerTwinCandidatesForIds).mock.calls[0][2]).toEqual([twinRow.id, cleanRow.id])
    // Precomputed: no per-row search.
    expect(vi.mocked(findLedgerTwinCandidates)).not.toHaveBeenCalled()

    expect(result.results[0]).toMatchObject({ id: twinRow.id, ok: false, error_code: 'LEDGER_TWIN_EXISTS' })
    expect(result.results[0].error_message).toContain('verifikat A185 (2026-01-15) och verifikat A186 (2026-01-17)')
    expect(result.results[0].ledger_twins?.map((t) => t.journal_entry_id)).toEqual([
      'je-imported-185',
      'je-imported-186',
    ])
    expect(result.results[1]).toMatchObject({ id: cleanRow.id, ok: true, voucher_number: 42 })
    expect(result.summary).toEqual({ total: 2, succeeded: 1, failed: 1 })
    expect(vi.mocked(createDraftEntry)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(commitEntry)).toHaveBeenCalledTimes(1)
  })

  it('batch: allowDuplicateIds books that one row anyway and keeps the guard on for the others', async () => {
    const { supabase, enqueue } = makeSupabase()
    const approved = makeSkvRow({ transaktionstext: 'Intäktsränta' })
    const guarded = makeSkvRow({ transaktionstext: 'Intäktsränta' })
    vi.mocked(findLedgerTwinCandidatesForIds).mockImplementationOnce(
      async (_s, _c, ids) => new Map(ids.map((id) => [id, [twinCandidate()]])),
    )

    enqueue({ data: SEED_RULES })
    enqueue({ data: { entity_type: 'aktiebolag' } })
    enqueue({ data: approved })
    enqueue({ data: [{ id: approved.id }] }) // claim approved row
    enqueue({ data: guarded })

    const result = await bokforSkattekontoTransactionsBatch(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      [approved.id, guarded.id],
      { allowDuplicateIds: [approved.id], duplicateReason: REASON },
    )

    // Both are searched: the approved row's verifikat names what it overrode.
    expect(vi.mocked(findLedgerTwinCandidatesForIds).mock.calls[0][2]).toEqual([approved.id, guarded.id])
    expect(result.results[0]).toMatchObject({ id: approved.id, ok: true })
    expect(result.results[1]).toMatchObject({ id: guarded.id, ok: false, error_code: 'LEDGER_TWIN_EXISTS' })
    expect(draftedNotes()).toContain(`(A185). Skäl: ${REASON}`)
  })

  it('batch: allowDuplicateIds without a reason keeps the guard on for every row', async () => {
    const { supabase, enqueue } = makeSupabase()
    const row = makeSkvRow({ transaktionstext: 'Intäktsränta' })
    vi.mocked(findLedgerTwinCandidatesForIds).mockImplementationOnce(
      async (_s, _c, ids) => new Map(ids.map((id) => [id, [twinCandidate()]])),
    )
    enqueue({ data: SEED_RULES })
    enqueue({ data: { entity_type: 'aktiebolag' } })
    enqueue({ data: row })

    const result = await bokforSkattekontoTransactionsBatch(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      [row.id],
      { allowDuplicateIds: [row.id] },
    )
    expect(result.results[0]).toMatchObject({ id: row.id, ok: false, error_code: 'LEDGER_TWIN_EXISTS' })
    expect(vi.mocked(createDraftEntry)).not.toHaveBeenCalled()
  })

  it('batch: a failed twin search books nothing (fails closed)', async () => {
    const { supabase, enqueue } = makeSupabase()
    const row = makeSkvRow({ transaktionstext: 'Intäktsränta' })
    vi.mocked(findLedgerTwinCandidatesForIds).mockRejectedValueOnce(
      new Error('Kunde inte söka kandidater: timeout'),
    )
    enqueue({ data: SEED_RULES })
    enqueue({ data: { entity_type: 'aktiebolag' } })

    await expect(
      bokforSkattekontoTransactionsBatch(
        supabase as unknown as SupabaseClient,
        'company-1',
        'user-1',
        [row.id],
      ),
    ).rejects.toThrow(/Kunde inte söka kandidater/)
    expect(vi.mocked(createDraftEntry)).not.toHaveBeenCalled()
  })
})

// Agent feedback seq 975032: Skatteverket's VAT refund clears the 1650
// receivable the momsavräkning booked, instead of crediting 2650.
describe('VAT refund routing (1650 receivable)', () => {
  const MOMS_RULE = {
    id: 'sys-6', priority: 20, pattern: 'mervärdesskatt,moms,momsdeklaration',
    amount_min: null, amount_max: null, company_type: 'all',
    counter_account: '2650', counter_account_ef: null,
    label: 'Redovisningskonto för moms', active: true,
  }

  it('books D 1630 / K 1650 when 1650 holds the receivable on the event date', async () => {
    const { supabase, enqueue } = makeSupabase()
    const row = makeSkvRow({
      transaktionstext: 'Moms juli 2026 - sept 2026',
      transaktionsdatum: '2026-10-05',
      belopp_skatteverket: 1240,
    })
    enqueue({ data: row })
    enqueue({ data: [MOMS_RULE] })
    enqueue({ data: { entity_type: 'aktiebolag' } })
    enqueue({ data: [{ id: row.id }] })
    vi.mocked(sumAccountBalance).mockResolvedValue(1240)

    await bokforSkattekontoTransaction(supabase as unknown as SupabaseClient, 'company-1', 'user-1', row.id)

    const input = vi.mocked(createDraftEntry).mock.calls[0][3]
    expect(input.lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['1630', 1240, 0],
      ['1650', 0, 1240],
    ])
    expect(vi.mocked(sumAccountBalance)).toHaveBeenCalledWith(expect.anything(), 'company-1', '1650', {
      cutoffDate: '2026-10-05',
    })
  })

  const bookRefund = async (refund: number, receivable: number) => {
    const { supabase, enqueue } = makeSupabase()
    const row = makeSkvRow({
      transaktionstext: 'Moms juli 2026 - sept 2026',
      transaktionsdatum: '2026-10-05',
      belopp_skatteverket: refund,
    })
    enqueue({ data: row })
    enqueue({ data: [MOMS_RULE] })
    enqueue({ data: { entity_type: 'aktiebolag' } })
    enqueue({ data: [{ id: row.id }] })
    vi.mocked(sumAccountBalance).mockResolvedValue(receivable)
    await bokforSkattekontoTransaction(supabase as unknown as SupabaseClient, 'company-1', 'user-1', row.id)
    const input = vi.mocked(createDraftEntry).mock.calls.at(-1)![3]
    const debit = input.lines.reduce((sum, l) => sum + l.debit_amount, 0)
    const credit = input.lines.reduce((sum, l) => sum + l.credit_amount, 0)
    expect(Math.round(debit * 100)).toBe(Math.round(credit * 100))
    return input.lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])
  }

  it('books a refund 1 kr above the receivable as K 1650 receivable + K 3740 1 kr', async () => {
    expect(await bookRefund(1241, 1240)).toEqual([
      ['1630', 1241, 0],
      ['1650', 0, 1240],
      ['3740', 0, 1],
    ])
  })

  it('books a refund 1 kr below the receivable as K 1650 receivable + D 3740 1 kr', async () => {
    expect(await bookRefund(1239, 1240)).toEqual([
      ['1630', 1239, 0],
      ['1650', 0, 1240],
      ['3740', 1, 0],
    ])
  })

  it('keeps K 2650 unchanged when the refund is more than 1 kr off the receivable', async () => {
    expect(await bookRefund(1242, 1240)).toEqual([
      ['1630', 1242, 0],
      ['2650', 0, 1242],
    ])
  })

  it('keeps D 2650 / K 1630 for a VAT charge', async () => {
    const { supabase, enqueue } = makeSupabase()
    const row = makeSkvRow({ transaktionstext: 'Moms april 2026 - juni 2026', belopp_skatteverket: -4200 })
    enqueue({ data: row })
    enqueue({ data: [MOMS_RULE] })
    enqueue({ data: { entity_type: 'aktiebolag' } })
    enqueue({ data: [{ id: row.id }] })
    vi.mocked(sumAccountBalance).mockResolvedValue(900)

    await bokforSkattekontoTransaction(supabase as unknown as SupabaseClient, 'company-1', 'user-1', row.id)

    const input = vi.mocked(createDraftEntry).mock.calls[0][3]
    expect(input.lines.map((l) => [l.account_number, l.debit_amount, l.credit_amount])).toEqual([
      ['2650', 4200, 0],
      ['1630', 0, 4200],
    ])
    expect(vi.mocked(sumAccountBalance)).not.toHaveBeenCalled()
  })

  it('suggests 1650 with the 3740 rounding in the preview, reading 1650 once per event date', async () => {
    const { supabase, enqueue } = makeSupabase()
    enqueue({ data: [MOMS_RULE] })
    enqueue({ data: { entity_type: 'aktiebolag' } })
    vi.mocked(sumAccountBalance).mockResolvedValue(1240)
    const rows = [
      makeSkvRow({ transaktionstext: 'Moms juli 2026 - sept 2026', transaktionsdatum: '2026-10-05', belopp_skatteverket: 1241 }),
      // Same date: 1650 is already taken by the first row (1240), so this one
      // keeps the rule's account.
      makeSkvRow({ transaktionstext: 'Mervärdesskatt', transaktionsdatum: '2026-10-05', belopp_skatteverket: 1 }),
    ]

    const enriched = await attachBookingSuggestions(supabase as unknown as SupabaseClient, 'company-1', rows)

    expect(enriched[0].booking_suggestion).toEqual({
      account: '1650',
      account_name: getBASReference('1650')?.account_name ?? null,
      label: getBASReference('1650')?.account_name ?? 'Momsfordran',
      ore_rounding: 1,
    })
    expect(enriched[1].booking_suggestion?.account).toBe('2650')
    expect(vi.mocked(sumAccountBalance)).toHaveBeenCalledTimes(1)
  })

  it('does not show two refunds clearing one receivable: the second keeps 2650', async () => {
    const { supabase, enqueue } = makeSupabase()
    enqueue({ data: [MOMS_RULE] })
    enqueue({ data: { entity_type: 'aktiebolag' } })
    vi.mocked(sumAccountBalance).mockResolvedValue(1240)
    const rows = [
      makeSkvRow({ transaktionstext: 'Moms juli 2026 - sept 2026', transaktionsdatum: '2026-10-05', belopp_skatteverket: 1240 }),
      makeSkvRow({ transaktionstext: 'Moms juli 2026 - sept 2026', transaktionsdatum: '2026-10-05', belopp_skatteverket: 1240 }),
      // A later date sees the earlier suggestion as already consumed too.
      makeSkvRow({ transaktionstext: 'Mervärdesskatt', transaktionsdatum: '2026-10-09', belopp_skatteverket: 300 }),
    ]

    const enriched = await attachBookingSuggestions(supabase as unknown as SupabaseClient, 'company-1', rows)

    expect(enriched.map((r) => r.booking_suggestion?.account)).toEqual(['1650', '2650', '2650'])
  })

  it('reads 1650 from the IB date when the account has an ingående balans', async () => {
    const { supabase, enqueue } = makeSupabase()
    const row = makeSkvRow({
      transaktionstext: 'Moms juli 2026 - sept 2026',
      transaktionsdatum: '2026-10-05',
      belopp_skatteverket: 1240,
    })
    enqueue({ data: row })
    enqueue({ data: [MOMS_RULE] })
    enqueue({ data: { entity_type: 'aktiebolag' } })
    enqueue({ data: [{ id: row.id }] })
    vi.mocked(findOpeningBalanceFloor).mockResolvedValue({ date: '2026-01-01', amount: 900, entryIds: ['ib-2026'] })
    vi.mocked(sumAccountBalance).mockResolvedValue(0)

    await bokforSkattekontoTransaction(supabase as unknown as SupabaseClient, 'company-1', 'user-1', row.id)

    expect(vi.mocked(sumAccountBalance)).toHaveBeenCalledWith(expect.anything(), 'company-1', '1650', {
      fromDate: '2026-01-01',
      cutoffDate: '2026-10-05',
    })
    const input = vi.mocked(createDraftEntry).mock.calls[0][3]
    expect(input.lines.map((l) => l.account_number)).toEqual(['1630', '2650'])
  })
})

// crm#1043: no verifikat carries any one of the rows, but one summarised
// year-end verifikat on 1630 already holds all of them. The bridge's
// arithmetic says so (the cover); the booking refuses and points at linking.
describe('ledger cover guard (a summarised verifikat already holds the rows)', () => {
  function coverFor(ids: string[], kind: SkattekontoLedgerCover['kind'] = 'ledger_agrees'): SkattekontoLedgerCover {
    return {
      account_number: '1630',
      through_date: '2026-12-31',
      kind,
      event_ids: ids,
      event_count: ids.length,
      event_total: -12345.5,
      entries: [
        {
          journal_entry_id: 'je-year-end',
          voucher_number: 1,
          voucher_series: 'B',
          entry_date: '2026-12-31',
          description: 'Skattekonto 2026',
          status: 'posted',
          open_amount: 37887.25,
        },
      ],
      entry_total: 37887.25,
    }
  }

  it('refuses a covered row with LEDGER_COVER_EXISTS before any rule, period or draft work, and says to link', async () => {
    const { supabase, enqueue } = makeSupabase()
    const row = makeSkvRow({ transaktionstext: 'Debiterad preliminärskatt', belopp_skatteverket: -8000, transaktionsdatum: '2026-06-12' })
    enqueue({ data: row }) // tx fetch
    bridgeCover(coverFor([row.id, 'another-row']))

    const err = await bokforSkattekontoTransaction(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      row.id,
    ).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(SkattekontoBookingError)
    const refusal = err as SkattekontoBookingError
    expect(refusal.code).toBe('LEDGER_COVER_EXISTS')
    expect(refusal.message).toContain('Händelsen ser redan ut att vara bokförd')
    expect(refusal.message).toContain('Konto 1630 stämmer redan med Skatteverket per 2026-12-31')
    expect(refusal.message).toContain('B1 (2026-12-31)')
    expect(refusal.message).toContain('Koppla händelserna till verifikatet i stället för att bokföra dem en gång till')
    expect(refusal.message).toContain('Matcha manuellt')
    expect(refusal.ledgerTwins).toBeUndefined()
    expect(refusal.ledgerCover).toEqual({
      account_number: '1630',
      through_date: '2026-12-31',
      kind: 'ledger_agrees',
      event_count: 2,
      event_total: -12345.5,
      entries: [
        {
          journal_entry_id: 'je-year-end',
          voucher_series: 'B',
          voucher_number: 1,
          entry_date: '2026-12-31',
          description: 'Skattekonto 2026',
          status: 'posted',
          open_amount: 37887.25,
        },
      ],
      entry_count: 1,
    })
    expect(vi.mocked(getSkattekontoReconciliationStatus)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(findFiscalPeriod)).not.toHaveBeenCalled()
    expect(vi.mocked(createDraftEntry)).not.toHaveBeenCalled()
    // Only the row itself was read: no rules fetch, no claim.
    expect(fromCount(supabase, 'skattekonto_rules')).toBe(0)
  })

  it('names the proof it has: rows that sum exactly to the unlinked verifikat', () => {
    const message = ledgerCoverMessage(toLedgerCoverInfo(coverFor(['a', 'b', 'c'], 'events_equal')))
    expect(message).toContain('motsvarar exakt de 3 obokförda händelserna t.o.m. 2026-12-31')
    expect(message).toContain('Bokför ändå bara om händelsen verkligen saknas i bokföringen.')
    expect(ledgerCoverMessage(toLedgerCoverInfo(coverFor(['a'], 'events_equal')))).toContain('den obokförda händelsen')
  })

  it('does not touch a row the cover does not name: normal booking is exactly as before', async () => {
    const { supabase, enqueue } = makeSupabase()
    const row = makeSkvRow({ transaktionstext: 'Intäktsränta', transaktionsdatum: '2027-01-12' })
    enqueue({ data: row })
    enqueue({ data: SEED_RULES })
    enqueue({ data: { entity_type: 'aktiebolag' } })
    enqueue({ data: [{ id: row.id }] }) // claim
    bridgeCover(coverFor(['some-other-row']))

    const entry = await bokforSkattekontoTransaction(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      row.id,
    )

    expect(entry.id).toBe('je-draft-1')
    expect(vi.mocked(createDraftEntry)).toHaveBeenCalledTimes(1)
  })

  it('a twin answers first: the cover is not even computed', async () => {
    const { supabase, enqueue } = makeSupabase()
    const row = makeSkvRow({ transaktionstext: 'Intäktsränta' })
    enqueue({ data: row })
    vi.mocked(findLedgerTwinCandidates).mockResolvedValueOnce(new Map([[row.id, [twinCandidate()]]]))
    bridgeCover(coverFor([row.id]))

    await expect(
      bokforSkattekontoTransaction(supabase as unknown as SupabaseClient, 'company-1', 'user-1', row.id),
    ).rejects.toMatchObject({ code: 'LEDGER_TWIN_EXISTS' })
    expect(vi.mocked(getSkattekontoReconciliationStatus)).not.toHaveBeenCalled()
  })

  it('never covers a kommande row: it is in no saldo yet (the single-row draft path)', async () => {
    const { supabase, enqueue } = makeSupabase()
    const row = makeSkvRow({ transaktionstext: 'Intäktsränta', status: 'upcoming' })
    enqueue({ data: row })
    enqueue({ data: SEED_RULES })
    enqueue({ data: { entity_type: 'aktiebolag' } })
    enqueue({ data: [{ id: row.id }] })
    bridgeCover(coverFor([row.id]))

    const entry = await bokforSkattekontoTransaction(supabase as unknown as SupabaseClient, 'company-1', 'user-1', row.id)
    expect(entry.id).toBe('je-draft-1')
    expect(vi.mocked(getSkattekontoReconciliationStatus)).not.toHaveBeenCalled()
  })

  it('books a covered row on the explicit override with a reason, and the verifikat names the cover', async () => {
    const { supabase, enqueue } = makeSupabase()
    const row = makeSkvRow({ transaktionstext: 'Intäktsränta' })
    enqueue({ data: row })
    enqueue({ data: SEED_RULES })
    enqueue({ data: { entity_type: 'aktiebolag' } })
    enqueue({ data: [{ id: row.id }] })
    bridgeCover(coverFor([row.id]))

    const entry = await bokforSkattekontoTransaction(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      row.id,
      undefined,
      { duplicateReason: REASON },
    )
    expect(entry.id).toBe('je-draft-1')
    expect(draftedNotes()).toContain(`Bokförd trots att bokföringen redan innehåller händelsen (B1). Skäl: ${REASON}`)
  })

  it('refuses to book when the ledger cannot be read: no answer is safe', async () => {
    const { supabase, enqueue } = makeSupabase()
    const row = makeSkvRow({ transaktionstext: 'Intäktsränta' })
    enqueue({ data: row })
    bridgeCover(null, true)

    await expect(
      bokforSkattekontoTransaction(supabase as unknown as SupabaseClient, 'company-1', 'user-1', row.id),
    ).rejects.toThrow(/Kunde inte kontrollera om händelsen redan finns i bokföringen/)
    expect(vi.mocked(createDraftEntry)).not.toHaveBeenCalled()
  })

  it('"Bokför 45 händelser": one bridge computation, every covered row skipped with the way out, nothing drafted', async () => {
    const { supabase, enqueue } = makeSupabase()
    const rows = Array.from({ length: 45 }, (_, i) =>
      makeSkvRow({
        transaktionstext: 'Debiterad preliminärskatt',
        belopp_skatteverket: -8000 - i,
        transaktionsdatum: '2026-06-12',
      }),
    )
    enqueue({ data: SEED_RULES }) // hoisted rules
    enqueue({ data: { entity_type: 'aktiebolag' } }) // hoisted entity_type
    for (const r of rows) enqueue({ data: r }) // tx fetch per row
    bridgeCover(coverFor(rows.map((r) => r.id)))

    const result = await bokforSkattekontoTransactionsBatch(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      rows.map((r) => r.id),
    )

    expect(result.summary).toEqual({ total: 45, succeeded: 0, failed: 45 })
    expect(result.results.every((r) => r.error_code === 'LEDGER_COVER_EXISTS')).toBe(true)
    expect(result.results[0].error_message).toContain('Koppla händelserna till verifikatet')
    expect(result.results[0].ledger_cover).toMatchObject({ through_date: '2026-12-31', event_count: 45, entry_count: 1 })
    // Cheap: one bridge computation for the whole batch, not one per row.
    expect(vi.mocked(getSkattekontoReconciliationStatus)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(createDraftEntry)).not.toHaveBeenCalled()
    expect(vi.mocked(commitEntry)).not.toHaveBeenCalled()
  })

  it('a batch books the rows the cover does not name and the rows overridden one by one, and skips the rest', async () => {
    const { supabase, enqueue } = makeSupabase()
    const covered = makeSkvRow({ transaktionstext: 'Intäktsränta', transaktionsdatum: '2026-06-12' })
    const overridden = makeSkvRow({ transaktionstext: 'Intäktsränta', transaktionsdatum: '2026-07-12' })
    const fresh = makeSkvRow({ transaktionstext: 'Intäktsränta', transaktionsdatum: '2027-01-12' })
    enqueue({ data: SEED_RULES })
    enqueue({ data: { entity_type: 'aktiebolag' } })
    enqueue({ data: covered }) // refused by the cover: no claim
    enqueue({ data: overridden })
    enqueue({ data: [{ id: overridden.id }] }) // claim
    enqueue({ data: fresh })
    enqueue({ data: [{ id: fresh.id }] }) // claim
    bridgeCover(coverFor([covered.id, overridden.id]))

    const result = await bokforSkattekontoTransactionsBatch(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      [covered.id, overridden.id, fresh.id],
      { allowDuplicateIds: [overridden.id], duplicateReason: REASON },
    )

    expect(result.results.map((r) => [r.id, r.ok, r.error_code])).toEqual([
      [covered.id, false, 'LEDGER_COVER_EXISTS'],
      [overridden.id, true, undefined],
      [fresh.id, true, undefined],
    ])
    expect(vi.mocked(getSkattekontoReconciliationStatus)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(commitEntry)).toHaveBeenCalledTimes(2)
  })

  it('a batch where every row is overridden still reads the bridge once, so each verifikat names what it overrode', async () => {
    const { supabase, enqueue } = makeSupabase()
    const row = makeSkvRow({ transaktionstext: 'Intäktsränta' })
    enqueue({ data: SEED_RULES })
    enqueue({ data: { entity_type: 'aktiebolag' } })
    enqueue({ data: row })
    enqueue({ data: [{ id: row.id }] })
    bridgeCover(coverFor([row.id]))

    const result = await bokforSkattekontoTransactionsBatch(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      [row.id],
      { allowDuplicateIds: [row.id], duplicateReason: REASON },
    )
    expect(result.summary.succeeded).toBe(1)
    expect(vi.mocked(getSkattekontoReconciliationStatus)).toHaveBeenCalledTimes(1)
    expect(draftedNotes()).toContain(`(B1). Skäl: ${REASON}`)
  })

  it('a company with nothing covered (no unlinked verifikat on 1630) books a batch exactly as before, for one bridge read', async () => {
    const { supabase, enqueue } = makeSupabase()
    const row1 = makeSkvRow({ transaktionstext: 'Intäktsränta' })
    const row2 = makeSkvRow({ transaktionstext: 'Kostnadsränta', belopp_skatteverket: -100 })
    enqueue({ data: SEED_RULES })
    enqueue({ data: { entity_type: 'aktiebolag' } })
    enqueue({ data: row1 })
    enqueue({ data: [{ id: row1.id }] })
    enqueue({ data: row2 })
    enqueue({ data: [{ id: row2.id }] })

    const result = await bokforSkattekontoTransactionsBatch(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      [row1.id, row2.id],
    )
    expect(result.summary).toEqual({ total: 2, succeeded: 2, failed: 0 })
    expect(vi.mocked(getSkattekontoReconciliationStatus)).toHaveBeenCalledTimes(1)
  })
})

// PH 175: an enskild firma that runs its skattekonto on 2012 in eget kapital.
describe('booking on the company skattekonto account', () => {
  it('books the owner preliminärskatt 2013 against 2012, and searches twins and cover on 2012', async () => {
    const { resolveSkattekontoAccount } = await import('@/lib/skatteverket/skattekonto-account')
    vi.mocked(resolveSkattekontoAccount).mockResolvedValueOnce('2012')
    const { supabase, enqueue } = makeSupabase()
    const row = makeSkvRow({ transaktionstext: 'Debiterad preliminärskatt', belopp_skatteverket: -2500 })
    enqueue({ data: SEED_RULES })
    enqueue({ data: { entity_type: 'enskild_firma' } })
    enqueue({ data: row })
    enqueue({ data: [{ id: row.id }] })

    const result = await bokforSkattekontoTransactionsBatch(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      [row.id],
    )

    expect(result.results[0]).toMatchObject({ id: row.id, ok: true })
    const input = vi.mocked(createDraftEntry).mock.calls[0][3]
    expect(input.lines).toEqual([
      expect.objectContaining({ account_number: '2013', debit_amount: 2500, credit_amount: 0 }),
      expect.objectContaining({ account_number: '2012', debit_amount: 0, credit_amount: 2500 }),
    ])
    expect(vi.mocked(findLedgerTwinCandidatesForIds)).toHaveBeenCalledWith(
      expect.anything(),
      'company-1',
      [row.id],
      '2012',
    )
    expect(vi.mocked(getSkattekontoReconciliationStatus)).toHaveBeenCalledWith(expect.anything(), 'company-1', {
      account: '2012',
    })
  })
})

describe('ledger plan guard (one monthly verifikat holds the rows, PH 171)', () => {
  // A cover through 31 December names other rows; the planned rows are dated
  // after it, in March, and the verifikat that holds them is February's.
  const YEAR_END_COVER: SkattekontoLedgerCover = {
    account_number: '1630',
    through_date: '2026-12-31',
    kind: 'events_equal',
    event_ids: ['row-december'],
    event_count: 1,
    event_total: -300,
    entries: [
      {
        journal_entry_id: 'je-december',
        voucher_number: 3,
        voucher_series: 'B',
        entry_date: '2026-12-31',
        description: 'Skattekonto december',
        status: 'posted',
        open_amount: -300,
      },
    ],
    entry_total: -300,
  }

  it('refuses a planned row dated after the cover date, naming the one verifikat and the rows it holds', async () => {
    const { supabase, enqueue } = makeSupabase()
    const row = makeSkvRow({ transaktionstext: 'Kostnadsränta', belopp_skatteverket: -100, transaktionsdatum: '2027-03-12' })
    enqueue({ data: row })
    bridgeCover(YEAR_END_COVER)
    bridgePlanned([row.id, 'row-prelskatt-march'])

    const err = await bokforSkattekontoTransaction(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      row.id,
    ).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(SkattekontoBookingError)
    const refusal = err as SkattekontoBookingError
    expect(refusal.code).toBe('LEDGER_COVER_EXISTS')
    expect(refusal.message).toContain('Händelsen finns redan i bokföringen: verifikat B7 (2027-02-28) på konto 1630')
    expect(refusal.message).toContain('den här händelsen och en annan obokförd händelse')
    expect(refusal.message).toContain('Koppla föreslagna')
    expect(refusal.ledgerCover).toMatchObject({
      kind: 'planned_link',
      through_date: '2027-03-26',
      event_count: 2,
      event_total: -5100,
      event_ids: [row.id, 'row-prelskatt-march'],
      entry_count: 1,
    })
    expect(refusal.ledgerCover?.entries[0].journal_entry_id).toBe('je-february')
    expect(vi.mocked(createDraftEntry)).not.toHaveBeenCalled()
    expect(fromCount(supabase, 'skattekonto_rules')).toBe(0)
  })

  it('a row both covered and planned gets the exact answer: the one verifikat of the plan', async () => {
    const { supabase, enqueue } = makeSupabase()
    const row = makeSkvRow({ transaktionstext: 'Kostnadsränta', belopp_skatteverket: -300, transaktionsdatum: '2026-12-14' })
    enqueue({ data: row })
    bridgeCover({ ...YEAR_END_COVER, event_ids: [row.id] })
    bridgePlanned([row.id], -300)

    await expect(
      bokforSkattekontoTransaction(supabase as unknown as SupabaseClient, 'company-1', 'user-1', row.id),
    ).rejects.toMatchObject({ code: 'LEDGER_COVER_EXISTS', ledgerCover: { kind: 'planned_link', event_count: 1 } })
  })

  it('a batch skips every planned row with its own verifikat, books the rest, for one bridge read', async () => {
    const { supabase, enqueue } = makeSupabase()
    const planned = makeSkvRow({ transaktionstext: 'Kostnadsränta', belopp_skatteverket: -100, transaktionsdatum: '2027-03-12' })
    const fresh = makeSkvRow({ transaktionstext: 'Intäktsränta', transaktionsdatum: '2027-04-12' })
    enqueue({ data: SEED_RULES })
    enqueue({ data: { entity_type: 'aktiebolag' } })
    enqueue({ data: planned })
    enqueue({ data: fresh })
    enqueue({ data: [{ id: fresh.id }] })
    bridgeCover(YEAR_END_COVER)
    bridgePlanned([planned.id, 'row-prelskatt-march'])

    const result = await bokforSkattekontoTransactionsBatch(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      [planned.id, fresh.id],
    )

    expect(result.results.map((r) => [r.id, r.ok, r.error_code])).toEqual([
      [planned.id, false, 'LEDGER_COVER_EXISTS'],
      [fresh.id, true, undefined],
    ])
    expect(result.results[0].ledger_cover).toMatchObject({ kind: 'planned_link', entries: [{ journal_entry_id: 'je-february' }] })
    expect(vi.mocked(getSkattekontoReconciliationStatus)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(createDraftEntry)).toHaveBeenCalledTimes(1)
  })

  it('books a planned row only on the override with a reason, and the verifikat names the monthly verifikat', async () => {
    const { supabase, enqueue } = makeSupabase()
    const row = makeSkvRow({ transaktionstext: 'Kostnadsränta', belopp_skatteverket: -100, transaktionsdatum: '2027-03-12' })
    enqueue({ data: row })
    enqueue({ data: SEED_RULES })
    enqueue({ data: { entity_type: 'aktiebolag' } })
    enqueue({ data: [{ id: row.id }] })
    bridgePlanned([row.id, 'row-prelskatt-march'])

    await bokforSkattekontoTransaction(supabase as unknown as SupabaseClient, 'company-1', 'user-1', row.id, undefined, {
      duplicateReason: REASON,
    })
    expect(draftedNotes()).toContain(`Bokförd trots att bokföringen redan innehåller händelsen (B7). Skäl: ${REASON}`)
  })
})

describe('ledgerHoldOf / ledgerHoldOfRows (the one check every door runs)', () => {
  const holding = (cover: string[], planned: string[]): SkattekontoLedgerHolding => ({
    account: '1630',
    cover: cover.length
      ? {
          account_number: '1630',
          through_date: '2026-12-31',
          kind: 'ledger_agrees',
          event_ids: cover,
          event_count: cover.length,
          event_total: -1,
          entries: [],
          entry_total: -1,
        }
      : null,
    covered: new Set(cover),
    planned: new Map(
      planned.map((id) => [
        id,
        {
          entry: {
            journal_entry_id: 'je-february',
            voucher_number: 7,
            voucher_series: 'B',
            entry_date: '2027-02-28',
            description: '',
            status: 'posted' as const,
            open_amount: -2,
          },
          event_ids: planned,
          total: -2,
          from_date: '2027-02-28',
          to_date: '2027-03-12',
        },
      ]),
    ),
  })

  it('answers null for a row the ledger does not hold, and for no skattekonto at all', () => {
    expect(ledgerHoldOf(holding(['a'], ['b']), 'c')).toBeNull()
    expect(ledgerHoldOf(null, 'a')).toBeNull()
  })

  it('answers the cover for a covered row and the plan for a planned one', () => {
    expect(ledgerHoldOf(holding(['a'], ['b']), 'a')?.kind).toBe('ledger_agrees')
    expect(ledgerHoldOf(holding(['a'], ['b']), 'b')?.kind).toBe('planned_link')
  })

  it('names the company skattekonto account in a planned hold, 2012 for a firm on 2012 (PH 175)', () => {
    const on2012 = { ...holding([], ['b']), account: '2012' as const }
    const held = ledgerHoldOf(on2012, 'b')
    expect(held?.account_number).toBe('2012')
    expect(ledgerCoverMessage(held!)).toContain('på konto 2012')
    expect(ledgerHoldOf(holding([], ['b']), 'b')?.account_number).toBe('1630')
  })

  it('answers for several rows only when the ledger holds every one', () => {
    expect(ledgerHoldOfRows(holding(['a'], ['b']), ['a', 'b'])).not.toBeNull()
    expect(ledgerHoldOfRows(holding(['a'], ['b']), ['a', 'c'])).toBeNull()
    expect(ledgerHoldOfRows(holding(['a'], []), [])).toBeNull()
  })
})

describe('direct-booking guard (a bank verifikat already books the event without 1630, PH 171)', () => {
  // The previous system's month verifikat: the bank paid the month's tax
  // straight to the tax accounts, no line on 1630.
  const HOLDER = {
    journal_entry_id: 'je-a14',
    voucher_series: 'A',
    voucher_number: 14,
    entry_date: '2026-01-31',
    description: 'Avstämning skattekonto',
    status: 'posted' as const,
  }

  it('refuses a single row with LEDGER_DIRECT_EXISTS, searched on its own counter line, before any period or draft work', async () => {
    const { supabase, enqueue } = makeSupabase()
    const row = makeSkvRow({ transaktionstext: 'Kostnadsränta', belopp_skatteverket: -159 })
    enqueue({ data: row })
    enqueue({ data: SEED_RULES })
    enqueue({ data: { entity_type: 'aktiebolag' } })
    vi.mocked(findDirectLedgerHolders).mockResolvedValueOnce(new Map([[row.id, [HOLDER]]]))

    const err = (await bokforSkattekontoTransaction(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      row.id,
    ).catch((e: unknown) => e)) as SkattekontoBookingError

    expect(err).toBeInstanceOf(SkattekontoBookingError)
    expect(err.code).toBe('LEDGER_DIRECT_EXISTS')
    expect(err.ledgerDirect).toEqual([HOLDER])
    expect(err.ledgerTwins).toBeUndefined()
    expect(err.ledgerCover).toBeUndefined()
    expect(err.message).toContain('Händelsen finns redan i bokföringen utan skattekontot: verifikat A14 (2026-01-31)')
    expect(err.message).toMatch(/159,00\s*kr på konto 8423 direkt mot banken, utan någon rad på konto 1630/)
    expect(err.message).toContain('ignorera den')
    // Searched for this row, on the line its verifikat would carry: D 8423.
    expect(vi.mocked(findDirectLedgerHolders).mock.calls[0][2]).toEqual([
      { id: row.id, transaktionsdatum: row.transaktionsdatum, counter: { account: '8423', net: 159 } },
    ])
    expect(vi.mocked(findDirectLedgerHolders).mock.calls[0][3]).toBe('1630')
    expect(vi.mocked(findFiscalPeriod)).not.toHaveBeenCalled()
    expect(vi.mocked(createDraftEntry)).not.toHaveBeenCalled()
  })

  it('books on the override with a reason, and the verifikat notes the bank verifikat and why', async () => {
    const { supabase, enqueue } = makeSupabase()
    const row = makeSkvRow({ transaktionstext: 'Kostnadsränta', belopp_skatteverket: -159 })
    enqueue({ data: row })
    enqueue({ data: SEED_RULES })
    enqueue({ data: { entity_type: 'aktiebolag' } })
    enqueue({ data: [{ id: row.id }] }) // claim
    vi.mocked(findDirectLedgerHolders).mockResolvedValueOnce(new Map([[row.id, [HOLDER]]]))

    const entry = await bokforSkattekontoTransaction(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      row.id,
      undefined,
      { duplicateReason: REASON },
    )

    expect(entry.id).toBe('je-draft-1')
    expect(draftedNotes()).toContain(`Bokförd trots att bokföringen redan innehåller händelsen (A14). Skäl: ${REASON}`)
  })

  it('does not search when a twin answers first: the override books over the twin and names it', async () => {
    const { supabase, enqueue } = makeSupabase()
    const row = makeSkvRow({ transaktionstext: 'Intäktsränta' })
    enqueue({ data: row })
    enqueue({ data: SEED_RULES })
    enqueue({ data: { entity_type: 'aktiebolag' } })
    enqueue({ data: [{ id: row.id }] })
    vi.mocked(findLedgerTwinCandidates).mockResolvedValueOnce(new Map([[row.id, [twinCandidate()]]]))

    await bokforSkattekontoTransaction(supabase as unknown as SupabaseClient, 'company-1', 'user-1', row.id, undefined, {
      duplicateReason: REASON,
    })
    expect(vi.mocked(findDirectLedgerHolders)).not.toHaveBeenCalled()
    expect(draftedNotes()).toContain('(A185)')
  })

  it('books a row nothing holds exactly as before, with no note', async () => {
    const { supabase, enqueue } = makeSupabase()
    const row = makeSkvRow({ transaktionstext: 'Kostnadsränta', belopp_skatteverket: -159 })
    enqueue({ data: row })
    enqueue({ data: SEED_RULES })
    enqueue({ data: { entity_type: 'aktiebolag' } })
    enqueue({ data: [{ id: row.id }] })

    const entry = await bokforSkattekontoTransaction(supabase as unknown as SupabaseClient, 'company-1', 'user-1', row.id)
    expect(entry.id).toBe('je-draft-1')
    expect(vi.mocked(findDirectLedgerHolders)).toHaveBeenCalledTimes(1)
    expect(draftedNotes()).not.toContain('Bokförd trots')
  })

  it('batch: one search for the rows no twin answers, skips the held row with its verifikat, books the rest', async () => {
    const { supabase, enqueue } = makeSupabase()
    const twinRow = makeSkvRow({ transaktionstext: 'Kostnadsränta', belopp_skatteverket: -1 })
    const directRow = makeSkvRow({ transaktionstext: 'Kostnadsränta', belopp_skatteverket: -159 })
    const cleanRow = makeSkvRow({ transaktionstext: 'Intäktsränta' })
    vi.mocked(findLedgerTwinCandidatesForIds).mockResolvedValueOnce(
      new Map([
        [twinRow.id, [twinCandidate({ matched_side: 'credit' })]],
        [directRow.id, []],
        [cleanRow.id, []],
      ]),
    )
    vi.mocked(findDirectLedgerHoldersForIds).mockResolvedValueOnce(
      new Map([
        [directRow.id, { counter: { account: '8423', net: 159 }, holders: [HOLDER] }],
        [cleanRow.id, { counter: { account: '8314', net: -1 }, holders: [] }],
      ]),
    )
    enqueue({ data: SEED_RULES })
    enqueue({ data: { entity_type: 'aktiebolag' } })
    enqueue({ data: twinRow })
    enqueue({ data: directRow })
    enqueue({ data: cleanRow })
    enqueue({ data: [{ id: cleanRow.id }] }) // claim clean row

    const result = await bokforSkattekontoTransactionsBatch(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      [twinRow.id, directRow.id, cleanRow.id],
    )

    expect(vi.mocked(findDirectLedgerHoldersForIds)).toHaveBeenCalledTimes(1)
    // The twin row is answered by its twin: not searched again.
    expect(vi.mocked(findDirectLedgerHoldersForIds).mock.calls[0][2]).toEqual([directRow.id, cleanRow.id])
    // Precomputed and the counter line unchanged: no per-row search.
    expect(vi.mocked(findDirectLedgerHolders)).not.toHaveBeenCalled()
    expect(result.results[0]).toMatchObject({ id: twinRow.id, ok: false, error_code: 'LEDGER_TWIN_EXISTS' })
    expect(result.results[1]).toMatchObject({
      id: directRow.id,
      ok: false,
      error_code: 'LEDGER_DIRECT_EXISTS',
      ledger_direct: [HOLDER],
    })
    expect(result.results[1].error_message).toContain('verifikat A14 (2026-01-31)')
    expect(result.results[2]).toMatchObject({ id: cleanRow.id, ok: true })
    expect(vi.mocked(createDraftEntry)).toHaveBeenCalledTimes(1)
  })

  it('batch: the pre-pass resolves each counter line the way the booking does', async () => {
    const { supabase, enqueue } = makeSupabase()
    const row = makeSkvRow({ transaktionstext: 'Kostnadsränta', belopp_skatteverket: -159 })
    let lines: unknown[] = []
    vi.mocked(findDirectLedgerHoldersForIds).mockImplementationOnce(async (_s, _c, _ids, account, counterOf) => {
      expect(account).toBe('1630')
      lines = [
        await counterOf({ ...row, transaktionstext: 'Kostnadsränta', belopp_skatteverket: -159 }),
        await counterOf({ ...row, transaktionstext: 'Intäktsränta', belopp_skatteverket: 9 }),
        await counterOf({ ...row, transaktionstext: 'Något okänt', belopp_skatteverket: -5 }),
      ]
      return new Map()
    })
    enqueue({ data: SEED_RULES })
    enqueue({ data: { entity_type: 'aktiebolag' } })
    enqueue({ data: row })
    enqueue({ data: [{ id: row.id }] })

    await bokforSkattekontoTransactionsBatch(supabase as unknown as SupabaseClient, 'company-1', 'user-1', [row.id])
    expect(lines).toEqual([{ account: '8423', net: 159 }, { account: '8314', net: -9 }, null])
  })

  it('batch: a row whose counter line changed after the pre-pass searches for itself', async () => {
    const { supabase, enqueue } = makeSupabase()
    const row = makeSkvRow({ transaktionstext: 'Kostnadsränta', belopp_skatteverket: -159 })
    vi.mocked(findDirectLedgerHoldersForIds).mockResolvedValueOnce(
      new Map([[row.id, { counter: { account: '8423', net: 1 }, holders: [] }]]),
    )
    vi.mocked(findDirectLedgerHolders).mockResolvedValueOnce(new Map([[row.id, [HOLDER]]]))
    enqueue({ data: SEED_RULES })
    enqueue({ data: { entity_type: 'aktiebolag' } })
    enqueue({ data: row })

    const result = await bokforSkattekontoTransactionsBatch(supabase as unknown as SupabaseClient, 'company-1', 'user-1', [row.id])
    expect(vi.mocked(findDirectLedgerHolders)).toHaveBeenCalledTimes(1)
    expect(result.results[0]).toMatchObject({ ok: false, error_code: 'LEDGER_DIRECT_EXISTS' })
  })

  it('batch: allowDuplicateIds with a reason books the held row and notes it', async () => {
    const { supabase, enqueue } = makeSupabase()
    const row = makeSkvRow({ transaktionstext: 'Kostnadsränta', belopp_skatteverket: -159 })
    vi.mocked(findDirectLedgerHoldersForIds).mockResolvedValueOnce(
      new Map([[row.id, { counter: { account: '8423', net: 159 }, holders: [HOLDER] }]]),
    )
    enqueue({ data: SEED_RULES })
    enqueue({ data: { entity_type: 'aktiebolag' } })
    enqueue({ data: row })
    enqueue({ data: [{ id: row.id }] })

    const result = await bokforSkattekontoTransactionsBatch(supabase as unknown as SupabaseClient, 'company-1', 'user-1', [row.id], {
      allowDuplicateIds: [row.id],
      duplicateReason: REASON,
    })
    expect(result.results[0]).toMatchObject({ ok: true })
    expect(draftedNotes()).toContain(`(A14). Skäl: ${REASON}`)
  })
})

describe('counterLineOf / ledgerDirectMessage', () => {
  const tx = { id: 'r1', transaktionsdatum: '2026-02-13', transaktionstext: 'Inbetalning bokförd 260212' }

  it('reads the counter line of the built verifikat in ledger sign: the bank for a payment, the tax account for a charge', () => {
    const payment = buildSkattekontoEntry({ ...tx, belopp_skatteverket: 60400 }, { account: '1930', label: 'Inbetalning' }, '1630')
    expect(counterLineOf(payment, '1630')).toEqual({ account: '1930', net: -60400 })
    const charge = buildSkattekontoEntry({ ...tx, belopp_skatteverket: -17637 }, { account: '2650', label: 'Moms' }, '2012')
    expect(counterLineOf(charge, '2012')).toEqual({ account: '2650', net: 17637 })
  })

  it('leaves the 3740 rounding line out: a refund that clears 1650 within a krona', () => {
    const refund = buildSkattekontoEntry(
      { ...tx, belopp_skatteverket: 1001 },
      { account: '1650', label: 'Momsfordran', oreRounding: 1 },
      '1630',
    )
    expect(counterLineOf(refund, '1630')).toEqual({ account: '1650', net: -1000 })
  })

  it('says what the verifikat books: the payment on the bank, a tax account against the bank', () => {
    const holder = { journal_entry_id: 'j', voucher_series: 'A', voucher_number: 172, entry_date: '2026-09-02', description: '', status: 'posted' as const }
    expect(ledgerDirectMessage([holder], { account: '1930', net: -618 }, '1630')).toMatch(
      /verifikat A172 \(2026-09-02\) bokför redan betalningen, 618,00\s*kr på konto 1930, utan någon rad på konto 1630/,
    )
    expect(ledgerDirectMessage([holder, { ...holder, voucher_number: 0, entry_date: '2026-09-05' }], { account: '2510', net: 618 }, '2012')).toMatch(
      /verifikat A172 \(2026-09-02\) och ett utkast \(2026-09-05\) bokför redan 618,00\s*kr på konto 2510 direkt mot banken, utan någon rad på konto 2012/,
    )
  })
})
