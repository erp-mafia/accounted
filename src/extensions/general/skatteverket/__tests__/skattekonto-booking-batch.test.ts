import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createQueuedMockSupabase } from '@/tests/helpers'

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

import { findFiscalPeriod, createDraftEntry, commitEntry } from '@/lib/bookkeeping/engine'
import {
  findLedgerTwinCandidates,
  findLedgerTwinCandidatesForIds,
  type SkattekontoMatchCandidate,
} from '../lib/skattekonto-match'
import { getBASReference } from '@/lib/bookkeeping/bas-reference'
import {
  attachBookingSuggestions,
  bokforSkattekontoTransaction,
  bokforSkattekontoTransactionsBatch,
  SkattekontoBookingError,
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
    counter_account: '2518', counter_account_ef: '2013',
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
})

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
    expect(enrichedAb[0].booking_suggestion?.account).toBe('2518')
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
      '2518',
    ])
    expect(fromCount(supabase, 'skattekonto_rules')).toBe(1)
    expect(fromCount(supabase, 'company_settings')).toBe(1)
  })

  it('resolves the __PRIMARY_SEK__ sentinel once via cash_accounts', async () => {
    const { supabase, enqueue } = makeSupabase()
    enqueue({ data: SEED_RULES })
    enqueue({ data: { entity_type: 'aktiebolag' } })
    enqueue({ data: { ledger_account: '1932' } }) // cash_accounts primary

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
    expect(err.message).toContain('Koppla raden till det tillsammans med en annan rad från samma dag')
    expect(err.ledgerTwins?.[0].combined_with?.map((c) => c.id)).toEqual(['row-agavg'])
  })

  it('books the row when allowDuplicate is set, without searching', async () => {
    const { supabase, enqueue } = makeSupabase()
    const row = makeSkvRow({ transaktionstext: 'Intäktsränta' })
    enqueue({ data: row })
    enqueue({ data: SEED_RULES })
    enqueue({ data: { entity_type: 'aktiebolag' } })
    enqueue({ data: [{ id: row.id }] }) // claim

    const entry = await bokforSkattekontoTransaction(
      supabase as unknown as SupabaseClient,
      'company-1',
      'user-1',
      row.id,
      undefined,
      { allowDuplicate: true },
    )

    expect(entry.id).toBe('je-draft-1')
    expect(vi.mocked(findLedgerTwinCandidates)).not.toHaveBeenCalled()
    expect(vi.mocked(createDraftEntry)).toHaveBeenCalledTimes(1)
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
      { allowDuplicateIds: [approved.id] },
    )

    // The approved row is not even searched.
    expect(vi.mocked(findLedgerTwinCandidatesForIds).mock.calls[0][2]).toEqual([guarded.id])
    expect(result.results[0]).toMatchObject({ id: approved.id, ok: true })
    expect(result.results[1]).toMatchObject({ id: guarded.id, ok: false, error_code: 'LEDGER_TWIN_EXISTS' })
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
