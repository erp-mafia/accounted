/**
 * gnubok_run_year_end: the staged preview names the closing account the
 * year-end service will actually post to (resultClosingAccounts(form)), so
 * the approval card never promises 2099 to a form that closes elsewhere.
 * The description stays account-agnostic for the same reason.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { tools } from '../server'

const runYearEnd = tools.find((t) => t.name === 'gnubok_run_year_end')!

const PERIOD = {
  id: 'fp-1',
  name: 'Räkenskapsår 2026',
  period_start: '2026-01-01',
  period_end: '2026-12-31',
  is_closed: false,
  locked_at: null,
}

type Staged = { staged: boolean; preview: Record<string, unknown> }

async function stageFor(entityType: string): Promise<Staged> {
  const { supabase, enqueue } = createQueuedMockSupabase()
  enqueue({ data: PERIOD }) // fiscal_periods
  enqueue({ data: { entity_type: entityType } }) // companies (resolveCompanyEntityType)
  enqueue({ data: { id: 'op-1' } }) // pending_operations insert
  return (await runYearEnd.execute(
    { fiscal_period_id: 'fp-1' },
    'company-1',
    'user-1',
    supabase as never,
    { type: 'api_key' },
  )) as Staged
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_run_year_end: form-aware preview', () => {
  it('keeps the description free of a specific account', () => {
    expect(runYearEnd.description).not.toContain('2099')
    expect(runYearEnd.description).toMatch(/result account/)
  })

  it('names 2069 Årets resultat for an ideell förening', async () => {
    const result = await stageFor('ideell_forening')
    expect(result.staged).toBe(true)
    expect(result.preview.closing_account).toBe('2069')
    expect(result.preview.closing_account_name).toBe('Årets resultat')
    expect(String(result.preview.will)).toMatch(/into 2069 Årets resultat/)
    expect(String(result.preview.will)).not.toContain('2099')
  })

  it('still names 2099 for an aktiebolag', async () => {
    const result = await stageFor('aktiebolag')
    expect(result.preview.closing_account).toBe('2099')
    expect(String(result.preview.will)).toMatch(/into 2099/)
  })

  it('refuses to stage when the company form is unknown instead of defaulting it', async () => {
    await expect(stageFor('handelsbolag')).rejects.toThrow(/Unknown company entity_type/)
  })
})
