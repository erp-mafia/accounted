import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/reports/ink2/ink2-engine', () => ({ generateINK2Declaration: vi.fn() }))

import { createQueuedMockSupabase } from '@/tests/helpers'
import { generateINK2Declaration } from '@/lib/reports/ink2/ink2-engine'
import type { Logger } from '@/lib/logger'
import { proposeLossCarryforward } from '../proposal'

const COMPANY = 'company-1'
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: vi.fn() } as unknown as Logger
const P2025 = { id: 'fp-2025', name: '2025', period_start: '2025-01-01', period_end: '2025-12-31' }
const P2026 = { id: 'fp-2026', name: '2026', period_start: '2026-01-01', period_end: '2026-12-31' }

const ink2s = (values: Record<string, number>) =>
  ({ ink2s: { '7670': 0, '7770': 0, '7763': 0, ...values } }) as unknown as Awaited<ReturnType<typeof generateINK2Declaration>>

let mock: ReturnType<typeof createQueuedMockSupabase>

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubEnv('BOLAGET_COMPANY_IDS', '*')
  mock = createQueuedMockSupabase()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('proposeLossCarryforward', () => {
  it('offers the previous year\'s INK2 underskott and slutskattebesked, and this year\'s result before the deduction', async () => {
    vi.mocked(generateINK2Declaration).mockImplementation(async (_s, _c, periodId) =>
      periodId === P2025.id ? ink2s({ '7770': 180_000 }) : ink2s({ '7670': 20_000, '7763': 180_000 }),
    )
    mock.enqueue({ data: { entity_type: 'aktiebolag' } }) // gate
    mock.enqueue({ data: [P2026] }) // the year
    mock.enqueue({ data: P2025 }) // the year before
    mock.enqueue({ data: { entity_type: 'aktiebolag' } }) // gate (list)
    mock.enqueue({ data: [] }) // register rows
    mock.enqueue({ data: [{ id: 'notice-1', decision_date: '2026-08-15' }] }) // slutskattebesked

    const outcome = await proposeLossCarryforward({ supabase: mock.supabase as never, companyId: COMPANY, log }, P2026.id)
    expect(outcome).toEqual({
      ok: true,
      data: {
        fiscal_period: P2026,
        previous_fiscal_period: P2025,
        existing: null,
        candidates: [
          { source: 'ink2_history', amount: 180_000, fiscal_period_id: P2025.id, fiscal_period_name: '2025' },
          {
            source: 'tax_assessment',
            amount: null,
            fiscal_period_id: P2025.id,
            fiscal_period_name: '2025',
            tax_assessment_notice_id: 'notice-1',
            decision_date: '2026-08-15',
          },
        ],
        // 4.15 20 000 with 4.14 a 180 000 added back.
        result_before_deficit: 200_000,
      },
    })
  })

  it('leaves out a figure the INK2 engine cannot produce, and logs why', async () => {
    vi.mocked(generateINK2Declaration).mockRejectedValue(new Error('Fiscal period not found'))
    mock.enqueue({ data: { entity_type: 'aktiebolag' } })
    mock.enqueue({ data: [P2026] })
    mock.enqueue({ data: null }) // no year before
    mock.enqueue({ data: { entity_type: 'aktiebolag' } })
    mock.enqueue({ data: [] })

    const outcome = await proposeLossCarryforward({ supabase: mock.supabase as never, companyId: COMPANY, log }, P2026.id)
    expect(outcome).toMatchObject({ ok: true, data: { previous_fiscal_period: null, candidates: [], result_before_deficit: null } })
    expect(log.warn).toHaveBeenCalled()
  })

  it('answers FISCAL_PERIOD_NOT_FOUND for a period the company does not have', async () => {
    mock.enqueue({ data: { entity_type: 'aktiebolag' } })
    mock.enqueue({ data: [] })
    const outcome = await proposeLossCarryforward({ supabase: mock.supabase as never, companyId: COMPANY, log }, 'nope')
    expect(outcome).toMatchObject({ ok: false, code: 'FISCAL_PERIOD_NOT_FOUND' })
  })
})
