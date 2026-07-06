import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { generateTaxDeadlinesForUser } from '../deadline-generator'
import type { CompanySettingsForDeadlines } from '../deadline-config'

const SETTINGS: CompanySettingsForDeadlines = {
  entity_type: 'aktiebolag',
  moms_period: 'monthly',
  f_skatt: true,
  vat_registered: true,
  pays_salaries: true,
  fiscal_year_start_month: 1,
}

// Future year so generated dates are never skipped as "in the past".
const FUTURE_YEAR = new Date().getFullYear() + 1

/**
 * Recording mock: captures the order of insert/delete operations and the
 * insert payload, so the tests can assert the insert-first/delete-after
 * ordering that prevents regeneration failures from wiping deadlines.
 */
function makeRecordingSupabase(opts: { insertError?: { code: string; message: string } } = {}) {
  const calls: string[] = []
  let insertPayload: Array<Record<string, unknown>> | null = null

  const from = vi.fn(() => {
    const chain: Record<string, ReturnType<typeof vi.fn>> = {}
    const self = () => chain
    chain.insert = vi.fn((rows: Array<Record<string, unknown>>) => {
      calls.push('insert')
      insertPayload = rows
      return {
        select: vi.fn(async () =>
          opts.insertError
            ? { data: null, error: opts.insertError }
            : { data: rows.map((_, i) => ({ id: `new-${i}` })), error: null }
        ),
      }
    })
    chain.delete = vi.fn(() => {
      calls.push('delete')
      return chain
    })
    chain.eq = vi.fn(self)
    chain.gte = vi.fn(self)
    chain.lte = vi.fn(self)
    chain.not = vi.fn((...args: unknown[]) => {
      calls.push(`not(${String(args[2]).slice(0, 20)}…)`)
      return chain
    })
    chain.select = vi.fn(async () => ({ data: [{ id: 'old-1' }, { id: 'old-2' }], error: null }))
    return chain
  })

  return {
    supabase: { from } as unknown as SupabaseClient,
    calls,
    getInsertPayload: () => insertPayload,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('generateTaxDeadlinesForUser', () => {
  it('inserts replacement rows before deleting the old set', async () => {
    const { supabase, calls } = makeRecordingSupabase()

    const result = await generateTaxDeadlinesForUser(supabase, 'company-1', SETTINGS, [FUTURE_YEAR])

    expect(calls[0]).toBe('insert')
    expect(calls[1]).toBe('delete')
    expect(result.created).toBeGreaterThan(0)
    expect(result.deleted).toBe(2)
  })

  it('excludes the newly inserted rows from the delete', async () => {
    const { supabase, calls } = makeRecordingSupabase()

    await generateTaxDeadlinesForUser(supabase, 'company-1', SETTINGS, [FUTURE_YEAR])

    expect(calls.some((c) => c.startsWith('not('))).toBe(true)
  })

  it('builds rows owned by company_id, without a user_id field', async () => {
    const { supabase, getInsertPayload } = makeRecordingSupabase()

    await generateTaxDeadlinesForUser(supabase, 'company-1', SETTINGS, [FUTURE_YEAR])

    const rows = getInsertPayload()
    expect(rows).not.toBeNull()
    for (const row of rows!) {
      expect(row.company_id).toBe('company-1')
      expect('user_id' in row).toBe(false)
      expect(row.source).toBe('system')
      expect(row.is_auto_generated).toBe(true)
    }
  })

  it('does not delete existing deadlines when the insert fails', async () => {
    const { supabase, calls } = makeRecordingSupabase({
      insertError: { code: '23502', message: 'null value in column "user_id"' },
    })

    await expect(
      generateTaxDeadlinesForUser(supabase, 'company-1', SETTINGS, [FUTURE_YEAR])
    ).rejects.toMatchObject({ code: '23502' })

    expect(calls).toContain('insert')
    expect(calls).not.toContain('delete')
  })
})
