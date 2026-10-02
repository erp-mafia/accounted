import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ClientDeadline } from '@/lib/clients/aggregate'

const mocks = vi.hoisted(() => ({
  fetchOverviewRowsForCompanies: vi.fn(),
}))

vi.mock('@/lib/clients/fetch-client-overview', () => ({
  fetchOverviewRowsForCompanies: (...args: unknown[]) => mocks.fetchOverviewRowsForCompanies(...args),
}))

import {
  applyOverviewFilters,
  deadlineMatchesKind,
  fetchPortfolioOverview,
  pickDeadlineForFilter,
  summarizeOverview,
  DEADLINE_KIND_FILTERS,
  DEADLINE_KIND_TYPES,
  type PortfolioCompanyRow,
} from '../overview'
import type { ResolvedCompanyScope } from '../scope'

const TODAY = '2026-09-19'

function deadline(over: Partial<ClientDeadline> = {}): ClientDeadline {
  return {
    title: 'Deadline',
    dueDate: '2026-10-12',
    taxDeadlineType: 'moms_quarterly',
    urgency: 'upcoming',
    ...over,
  }
}

function row(over: Partial<PortfolioCompanyRow> = {}): PortfolioCompanyRow {
  return {
    companyId: 'c-1',
    name: 'Alpha AB',
    orgNumber: null,
    unbookedCount: 0,
    inboxCount: 0,
    nextDeadline: null,
    lastBookedDate: null,
    deadlines: [],
    role: 'member',
    teamId: null,
    entityType: 'aktiebolag',
    ...over,
  }
}

describe('deadlineMatchesKind', () => {
  it('maps every tax_deadline_type of a kind and nothing else', () => {
    expect(deadlineMatchesKind('moms_monthly', 'vat')).toBe(true)
    expect(deadlineMatchesKind('moms_quarterly', 'vat')).toBe(true)
    expect(deadlineMatchesKind('moms_yearly', 'vat')).toBe(true)
    expect(deadlineMatchesKind('oss_quarterly', 'vat')).toBe(true)
    expect(deadlineMatchesKind('ioss_monthly', 'vat')).toBe(true)
    expect(deadlineMatchesKind('arbetsgivardeklaration', 'vat')).toBe(false)

    expect(deadlineMatchesKind('arbetsgivardeklaration', 'agi')).toBe(true)
    expect(deadlineMatchesKind('f_skatt', 'f_skatt')).toBe(true)
    expect(deadlineMatchesKind('skatteinbetalning', 'f_skatt')).toBe(true)
    expect(deadlineMatchesKind('inkomstdeklaration_ef', 'inkomstdeklaration')).toBe(true)
    expect(deadlineMatchesKind('inkomstdeklaration_ab', 'inkomstdeklaration')).toBe(true)
    expect(deadlineMatchesKind('arsredovisning', 'arsredovisning')).toBe(true)
    expect(deadlineMatchesKind('arsstamma', 'arsredovisning')).toBe(true)
    expect(deadlineMatchesKind('periodisk_sammanstallning', 'arsredovisning')).toBe(false)
  })

  it("'any' matches every tax deadline but never a custom one (null type)", () => {
    expect(deadlineMatchesKind('kontrolluppgifter', 'any')).toBe(true)
    expect(deadlineMatchesKind(null, 'any')).toBe(false)
    expect(deadlineMatchesKind(null, 'vat')).toBe(false)
  })

  it('every filter kind except any has a type list', () => {
    for (const kind of DEADLINE_KIND_FILTERS) {
      if (kind === 'any') continue
      expect(DEADLINE_KIND_TYPES[kind].length).toBeGreaterThan(0)
    }
  })
})

describe('pickDeadlineForFilter', () => {
  it('returns nextDeadline when no kind is asked for', () => {
    const next = deadline({ taxDeadlineType: null, title: 'Custom' })
    expect(pickDeadlineForFilter(row({ nextDeadline: next }), undefined)).toBe(next)
  })

  it('returns the earliest deadline of the kind from the list', () => {
    const r = row({
      deadlines: [
        deadline({ dueDate: '2026-09-25', taxDeadlineType: 'arbetsgivardeklaration' }),
        deadline({ dueDate: '2026-11-12', taxDeadlineType: 'moms_quarterly', title: 'later' }),
        deadline({ dueDate: '2026-10-12', taxDeadlineType: 'moms_quarterly', title: 'earlier' }),
      ],
    })
    expect(pickDeadlineForFilter(r, 'vat')?.title).toBe('earlier')
    expect(pickDeadlineForFilter(r, 'agi')?.dueDate).toBe('2026-09-25')
    expect(pickDeadlineForFilter(r, 'f_skatt')).toBeNull()
  })

  it('falls back to nextDeadline when the row carries no deadline list', () => {
    const next = deadline({ taxDeadlineType: 'f_skatt' })
    const r = row({ nextDeadline: next })
    delete r.deadlines
    expect(pickDeadlineForFilter(r, 'f_skatt')).toBe(next)
    expect(pickDeadlineForFilter(r, 'vat')).toBeNull()
  })
})

describe('applyOverviewFilters', () => {
  const vatSoon = row({
    companyId: 'vat-soon',
    unbookedCount: 5,
    inboxCount: 2,
    nextDeadline: deadline({ dueDate: '2026-09-26', taxDeadlineType: 'moms_quarterly' }),
    deadlines: [deadline({ dueDate: '2026-09-26', taxDeadlineType: 'moms_quarterly' })],
  })
  const agiOverdue = row({
    companyId: 'agi-overdue',
    unbookedCount: 20,
    inboxCount: 0,
    nextDeadline: deadline({
      dueDate: '2026-09-12',
      taxDeadlineType: 'arbetsgivardeklaration',
      urgency: 'overdue',
    }),
    deadlines: [
      deadline({ dueDate: '2026-09-12', taxDeadlineType: 'arbetsgivardeklaration', urgency: 'overdue' }),
      deadline({ dueDate: '2026-11-12', taxDeadlineType: 'moms_quarterly' }),
    ],
  })
  const customOnly = row({
    companyId: 'custom-only',
    unbookedCount: 1,
    inboxCount: 7,
    nextDeadline: deadline({ dueDate: '2026-09-20', taxDeadlineType: null, title: 'Styrelsemöte' }),
    deadlines: [deadline({ dueDate: '2026-09-20', taxDeadlineType: null, title: 'Styrelsemöte' })],
  })
  const nothing = row({ companyId: 'nothing' })
  const rows = [agiOverdue, vatSoon, customOnly, nothing]

  it('returns every row in the same order with no filters', () => {
    expect(applyOverviewFilters(rows, {}, TODAY)).toEqual(rows)
  })

  it('deadline_kind keeps only companies with an open deadline of that kind', () => {
    expect(applyOverviewFilters(rows, { deadlineKind: 'vat' }, TODAY).map((r) => r.companyId)).toEqual([
      'agi-overdue',
      'vat-soon',
    ])
    expect(applyOverviewFilters(rows, { deadlineKind: 'agi' }, TODAY).map((r) => r.companyId)).toEqual([
      'agi-overdue',
    ])
    expect(applyOverviewFilters(rows, { deadlineKind: 'f_skatt' }, TODAY)).toEqual([])
    expect(applyOverviewFilters(rows, { deadlineKind: 'inkomstdeklaration' }, TODAY)).toEqual([])
    expect(applyOverviewFilters(rows, { deadlineKind: 'arsredovisning' }, TODAY)).toEqual([])
    // any: tax deadlines only, so the custom-only company is out.
    expect(applyOverviewFilters(rows, { deadlineKind: 'any' }, TODAY).map((r) => r.companyId)).toEqual([
      'agi-overdue',
      'vat-soon',
    ])
  })

  it('deadline_within_days is inclusive on the boundary day', () => {
    // vat-soon is due 2026-09-26 = TODAY + 7.
    expect(
      applyOverviewFilters(rows, { deadlineKind: 'vat', deadlineWithinDays: 7 }, TODAY).map((r) => r.companyId),
    ).toEqual(['vat-soon'])
    expect(
      applyOverviewFilters(rows, { deadlineKind: 'vat', deadlineWithinDays: 6 }, TODAY).map((r) => r.companyId),
    ).toEqual([])
    // The kind's earliest deadline is what the window applies to: agi-overdue's
    // VAT deadline is in November, so a 30-day window excludes it.
    expect(
      applyOverviewFilters(rows, { deadlineKind: 'vat', deadlineWithinDays: 60 }, TODAY).map((r) => r.companyId),
    ).toEqual(['agi-overdue', 'vat-soon'])
  })

  it('overdue deadlines are inside every window', () => {
    expect(
      applyOverviewFilters(rows, { deadlineKind: 'agi', deadlineWithinDays: 1 }, TODAY).map((r) => r.companyId),
    ).toEqual(['agi-overdue'])
  })

  it('deadline_within_days alone looks at the next deadline of any kind, custom included', () => {
    expect(applyOverviewFilters(rows, { deadlineWithinDays: 1 }, TODAY).map((r) => r.companyId)).toEqual([
      'agi-overdue',
      'custom-only',
    ])
    expect(applyOverviewFilters(rows, { deadlineWithinDays: 7 }, TODAY).map((r) => r.companyId)).toEqual([
      'agi-overdue',
      'vat-soon',
      'custom-only',
    ])
  })

  it('a row without a matching deadline is excluded whenever a deadline filter is set', () => {
    expect(applyOverviewFilters([nothing], { deadlineWithinDays: 365 }, TODAY)).toEqual([])
    expect(applyOverviewFilters([nothing], { deadlineKind: 'any' }, TODAY)).toEqual([])
  })

  it('min_unbooked and min_inbox are inclusive thresholds and combine with the deadline filters', () => {
    expect(applyOverviewFilters(rows, { minUnbooked: 5 }, TODAY).map((r) => r.companyId)).toEqual([
      'agi-overdue',
      'vat-soon',
    ])
    expect(applyOverviewFilters(rows, { minUnbooked: 0 }, TODAY)).toHaveLength(4)
    expect(applyOverviewFilters(rows, { minInbox: 7 }, TODAY).map((r) => r.companyId)).toEqual(['custom-only'])
    expect(
      applyOverviewFilters(rows, { minUnbooked: 5, deadlineKind: 'agi' }, TODAY).map((r) => r.companyId),
    ).toEqual(['agi-overdue'])
    expect(applyOverviewFilters(rows, { minUnbooked: 5, minInbox: 1 }, TODAY).map((r) => r.companyId)).toEqual([
      'vat-soon',
    ])
  })
})

describe('summarizeOverview', () => {
  it('counts scope size, matched rows, totals and next-deadline urgencies', () => {
    const summary = summarizeOverview(9, [
      row({ unbookedCount: 3, inboxCount: 1, nextDeadline: deadline({ urgency: 'overdue' }) }),
      row({ unbookedCount: 4, inboxCount: 0, nextDeadline: deadline({ urgency: 'action_needed' }) }),
      row({ unbookedCount: 0, inboxCount: 2, nextDeadline: deadline({ urgency: 'upcoming' }) }),
      row({ unbookedCount: 1, inboxCount: 0, nextDeadline: null }),
    ])
    expect(summary).toEqual({
      companies: 9,
      matched: 4,
      unbooked_total: 8,
      inbox_total: 3,
      overdue: 1,
      action_needed: 1,
    })
  })
})

describe('fetchPortfolioOverview', () => {
  const supabase = {} as SupabaseClient
  const scope: ResolvedCompanyScope = {
    companies: [
      {
        companyId: 'c-1',
        name: 'Alpha AB',
        orgNumber: '5560125790',
        entityType: 'aktiebolag',
        role: 'owner',
        teamId: null,
      },
      {
        companyId: 'c-2',
        name: 'Beta',
        orgNumber: null,
        entityType: 'enskild_firma',
        role: 'member',
        teamId: 'team-1',
      },
    ],
    truncated: false,
    remainingCompanyIds: [],
    unresolved: [],
    team: { id: 'team-1', name: 'Siffra' },
  }

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('short-circuits an empty scope without querying', async () => {
    const overview = await fetchPortfolioOverview(
      supabase,
      { ...scope, companies: [] },
      {},
    )
    expect(mocks.fetchOverviewRowsForCompanies).not.toHaveBeenCalled()
    expect(overview).toEqual({
      team: scope.team,
      summary: { companies: 0, matched: 0, unbooked_total: 0, inbox_total: 0, overdue: 0, action_needed: 0 },
      companies: [],
    })
  })

  it('runs the cockpit rows over the scope with deadlines, merges role/team/entity and filters', async () => {
    mocks.fetchOverviewRowsForCompanies.mockResolvedValue([
      {
        companyId: 'c-2',
        name: 'Beta',
        orgNumber: null,
        unbookedCount: 12,
        inboxCount: 0,
        nextDeadline: deadline({ dueDate: '2026-09-12', urgency: 'overdue' }),
        lastBookedDate: null,
        deadlines: [deadline({ dueDate: '2026-09-12', urgency: 'overdue' })],
      },
      {
        companyId: 'c-1',
        name: 'Alpha AB',
        orgNumber: '5560125790',
        unbookedCount: 2,
        inboxCount: 1,
        nextDeadline: null,
        lastBookedDate: '2026-09-01',
        deadlines: [],
      },
    ])

    const overview = await fetchPortfolioOverview(supabase, scope, { minUnbooked: 10 })

    expect(mocks.fetchOverviewRowsForCompanies).toHaveBeenCalledWith(
      supabase,
      [
        { id: 'c-1', name: 'Alpha AB', org_number: '5560125790' },
        { id: 'c-2', name: 'Beta', org_number: null },
      ],
      { includeDeadlines: true },
    )
    expect(overview.team).toEqual({ id: 'team-1', name: 'Siffra' })
    expect(overview.companies).toHaveLength(1)
    expect(overview.companies[0]).toMatchObject({
      companyId: 'c-2',
      role: 'member',
      teamId: 'team-1',
      entityType: 'enskild_firma',
      unbookedCount: 12,
    })
    expect(overview.summary).toEqual({
      companies: 2,
      matched: 1,
      unbooked_total: 12,
      inbox_total: 0,
      overdue: 1,
      action_needed: 0,
    })
  })
})
