import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/reports/ink2/ink2-engine', () => ({ generateINK2Declaration: vi.fn() }))
vi.mock('@/lib/reports/trial-balance', () => ({
  generateTrialBalance: vi.fn().mockResolvedValue({ rows: [] }),
}))

import { createRowsMockSupabase } from '@/tests/helpers'
import { generateINK2Declaration } from '@/lib/reports/ink2/ink2-engine'
import type { Logger } from '@/lib/logger'
import { proposeLossCarryforward } from '@/lib/bokslut/loss-carryforward/proposal'
import { previousYearHasBookkeeping } from '@/lib/import/opening-balance/sie-file'
import { ensureFiscalPeriod as ensureSieFiscalPeriod } from '@/lib/import/sie-import'
import { generateKassaflodesanalysWithStatement } from '@/lib/reports/kassaflodesanalys'

/**
 * The year before a räkenskapsår ends the day before it starts; a year across
 * a gap is never it (resolvePreviousFiscalPeriod). Each door here answered
 * "the nearest earlier year" or read the year itself: 2024 is missing, 92
 * years on prod sit behind such a gap.
 */
const COMPANY = 'company-1'
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() } as unknown as Logger

const year = (id: string, y: number, previous: string | null = null) => ({
  id,
  company_id: COMPANY,
  name: id,
  period_start: `${y}-01-01`,
  period_end: `${y}-12-31`,
  previous_period_id: previous,
  opening_balance_entry_id: null,
  is_closed: false,
  locked_at: null,
  opening_balances_set: false,
  closed_externally: false,
  closing_entry_id: null,
})

const ink2s = (values: Record<string, number>) =>
  ({ ink2s: { '7670': 0, '7770': 0, '7763': 0, ...values } }) as unknown as Awaited<ReturnType<typeof generateINK2Declaration>>

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('BOLAGET_COMPANY_IDS', '*')
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('the loss-carryforward proposal', () => {
  const tables = (periods: ReturnType<typeof year>[]) => ({
    fiscal_periods: periods,
    companies: [{ id: COMPANY, entity_type: 'aktiebolag' }],
    company_settings: [{ company_id: COMPANY, entity_type: 'aktiebolag' }],
    tax_loss_carryforwards: [
      { id: 'row-2023', company_id: COMPANY, fiscal_period_id: 'fy2023', carried_forward: 90_000, brought_forward: 0, group_contributions_received: 0, amount_block_reduction: 0, group_block_reduction: 0 },
    ],
    tax_assessment_notices: [
      { id: 'notice-2023', company_id: COMPANY, fiscal_period_id: 'fy2023', decision_date: '2024-11-29', archived_at: null },
    ],
  })

  beforeEach(() => {
    vi.mocked(generateINK2Declaration).mockImplementation(async (_s, _c, periodId) =>
      periodId === 'fy2023' ? ink2s({ '7770': 90_000 }) : ink2s({}),
    )
  })

  it('offers no deficit from two years back as last year\'s', async () => {
    const { supabase } = createRowsMockSupabase(tables([year('fy2023', 2023), year('fy2025', 2025, 'fy2023')]))
    const outcome = await proposeLossCarryforward({ supabase: supabase as never, companyId: COMPANY, log }, 'fy2025')
    expect(outcome).toMatchObject({ ok: true, data: { previous_fiscal_period: null, candidates: [] } })
  })

  it('offers the year that ends the day before', async () => {
    const { supabase } = createRowsMockSupabase(tables([year('fy2023', 2023), year('fy2024', 2024)]))
    const outcome = await proposeLossCarryforward({ supabase: supabase as never, companyId: COMPANY, log }, 'fy2024')
    expect(outcome).toMatchObject({ ok: true, data: { previous_fiscal_period: { id: 'fy2023' } } })
  })
})

describe('the SIE opening-balance review', () => {
  const entries = [{ id: 'j', company_id: COMPANY, fiscal_period_id: 'fy2023', status: 'posted', source_type: 'manual' }]

  it('takes no evidence from a year across a gap', async () => {
    const { supabase } = createRowsMockSupabase({
      fiscal_periods: [year('fy2023', 2023), year('fy2025', 2025, 'fy2023')],
      journal_entries: entries,
    })
    await expect(previousYearHasBookkeeping(supabase as never, COMPANY, '2025-01-01')).resolves.toBe(false)
  })

  it('reads the year that ends the day before', async () => {
    const { supabase } = createRowsMockSupabase({
      fiscal_periods: [year('fy2023', 2023), year('fy2024', 2024)],
      journal_entries: entries,
    })
    await expect(previousYearHasBookkeeping(supabase as never, COMPANY, '2024-01-01')).resolves.toBe(true)
  })
})

describe('the SIE import\'s chain link', () => {
  const insertedLink = async (periods: ReturnType<typeof year>[]) => {
    const writes: { table: string; method: string; row: unknown }[] = []
    const { supabase } = createRowsMockSupabase({
      fiscal_periods: periods,
      companies: [{ id: COMPANY, entity_type: 'aktiebolag' }],
    }, writes)
    await ensureSieFiscalPeriod(supabase as never, COMPANY, '2025-01-01', '2025-12-31')
    const insert = writes.find((write) => write.method === 'insert')
    return (insert?.row as { previous_period_id?: string | null }).previous_period_id
  }

  it('links a new year to the one ending the day before', async () => {
    await expect(insertedLink([year('fy2024', 2024)])).resolves.toBe('fy2024')
  })

  it('leaves a year across a gap unlinked', async () => {
    await expect(insertedLink([year('fy2023', 2023)])).resolves.toBeNull()
  })
})

describe('the kassaflödesanalys comparison column', () => {
  const statusOf = async (periods: ReturnType<typeof year>[], current: string) => {
    const { supabase } = createRowsMockSupabase({ fiscal_periods: periods, journal_entries: [] })
    const report = await generateKassaflodesanalysWithStatement(supabase as never, COMPANY, current, {
      includePreviousYear: true,
    })
    return report.statement.previous_status
  }

  it('finds no comparison year across a gap', async () => {
    await expect(statusOf([year('fy2023', 2023), year('fy2025', 2025, 'fy2023')], 'fy2025')).resolves.toBe('no_previous_period')
  })

  it('reads the adjacent year', async () => {
    await expect(statusOf([year('fy2024', 2024), year('fy2025', 2025, 'fy2024')], 'fy2025')).resolves.toBe('no_activity')
  })
})
