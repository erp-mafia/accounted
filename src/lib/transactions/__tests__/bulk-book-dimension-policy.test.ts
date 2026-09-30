/**
 * enforceBulkBookDimensionPolicy: the one dimension pre-check every
 * bulk-book door runs before the bulk_book_transactions RPC (which inserts
 * and commits in SQL, outside createDraftEntry/commitEntry). Same layers,
 * order and toggle semantics as the engine: default/fixed rules applied,
 * registry validation, then 'required' rules asserted.
 */
import { describe, it, expect, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Logger } from '@/lib/logger'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { enforceBulkBookDimensionPolicy } from '../bulk-book'
import { DimensionValidationError, MandatoryDimensionMissingError } from '@/lib/bookkeeping/errors'

type Line = {
  account_number: string
  debit_amount: number
  credit_amount: number
  currency: string
  dimensions?: Record<string, string>
}

const LINES: Line[] = [
  { account_number: '4010', debit_amount: 400, credit_amount: 0, currency: 'SEK' },
  { account_number: '1930', debit_amount: 0, credit_amount: 400, currency: 'SEK' },
]

const REGISTRY = [
  { id: 'dim-ks', sie_dim_no: 1, name: 'Kostnadsställe', is_active: true },
  { id: 'dim-proj', sie_dim_no: 6, name: 'Projekt', is_active: true },
]

function ruleRow(overrides: Record<string, unknown> = {}) {
  return {
    account_number: '4010',
    rule_type: 'default',
    dimensions: { sie_dim_no: 6, name: 'Projekt' },
    dimension_values: { code: 'P001' },
    ...overrides,
  }
}

function tables(q: ReturnType<typeof createQueuedMockSupabase>): string[] {
  return q.supabase.from.mock.calls.map((call) => call[0] as string)
}

function run(q: ReturnType<typeof createQueuedMockSupabase>, lines: Line[], log?: Pick<Logger, 'warn'>) {
  return enforceBulkBookDimensionPolicy(q.supabase as unknown as SupabaseClient, 'company-1', lines, log)
}

describe('enforceBulkBookDimensionPolicy', () => {
  it('costs one rules query and returns the same lines for an untagged, rule-less booking', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({ data: [] }) // account_dimension_rules

    const out = await run(q, LINES)

    expect(out).toBe(LINES)
    expect(tables(q)).toEqual(['account_dimension_rules'])
  })

  it('applies a default rule and validates the resulting tag against the registry', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({ data: [ruleRow()] })
    q.enqueue({ data: { dimensions_enabled: true } })
    q.enqueue({ data: REGISTRY })
    q.enqueue({ data: [{ dimension_id: 'dim-proj', code: 'P001', is_active: true }] })

    const out = await run(q, LINES)

    expect(out[0].dimensions).toEqual({ '6': 'P001' })
    expect(out[0].currency).toBe('SEK')
    expect(out[1]).toBe(LINES[1])
    expect(tables(q)).toEqual(['account_dimension_rules', 'company_settings', 'dimensions', 'dimension_values'])
  })

  it('refuses an archived code before the RPC (registry validation, toggle on)', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({ data: [] })
    q.enqueue({ data: { dimensions_enabled: true } })
    q.enqueue({ data: REGISTRY })
    q.enqueue({ data: [{ dimension_id: 'dim-proj', code: 'P001', is_active: false }] })

    const tagged = [{ ...LINES[0], dimensions: { '6': 'P001' } }, LINES[1]]
    await expect(run(q, tagged)).rejects.toBeInstanceOf(DimensionValidationError)
  })

  it('refuses a code of an archived dimension', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({ data: [] })
    q.enqueue({ data: { dimensions_enabled: true } })
    q.enqueue({ data: [{ id: 'dim-kb', sie_dim_no: 21, name: 'Kostnadsbärare', is_active: false }] })

    const tagged = [{ ...LINES[0], dimensions: { '21': 'KB1' } }, LINES[1]]
    await expect(run(q, tagged)).rejects.toMatchObject({
      code: 'DIMENSION_VALIDATION_FAILED',
      issues: [{ sie_dim_no: '21', code: 'KB1', reason: 'archived_dimension' }],
    })
  })

  it('keeps free-text tags while dimensions_enabled is off', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({ data: [] })
    q.enqueue({ data: { dimensions_enabled: false } })

    const tagged = [{ ...LINES[0], dimensions: { '6': 'FRITEXT' } }, LINES[1]]
    await expect(run(q, tagged)).resolves.toBe(tagged)
    expect(tables(q)).toEqual(['account_dimension_rules', 'company_settings'])
  })

  it('asserts a required rule on the lines', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({ data: [ruleRow({ rule_type: 'required', dimension_values: null })] })

    await expect(run(q, LINES)).rejects.toBeInstanceOf(MandatoryDimensionMissingError)
  })

  it('satisfies a required rule with a default rule on the same account', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({
      data: [
        ruleRow({ rule_type: 'required', dimension_values: null }),
        ruleRow({ rule_type: 'default' }),
      ],
    })
    q.enqueue({ data: { dimensions_enabled: false } })

    const out = await run(q, LINES)

    expect(out[0].dimensions).toEqual({ '6': 'P001' })
  })

  it('fails open on a failed rule fetch but still validates the registry', async () => {
    const q = createQueuedMockSupabase()
    q.enqueue({ data: null, error: { message: 'transient' } })
    q.enqueue({ data: { dimensions_enabled: true } })
    q.enqueue({ data: REGISTRY })
    q.enqueue({ data: [] })
    const log = { warn: vi.fn<Logger['warn']>() }

    const tagged = [{ ...LINES[0], dimensions: { '6': 'P999' } }, LINES[1]]
    await expect(run(q, tagged, log)).rejects.toBeInstanceOf(DimensionValidationError)
    expect(log.warn).toHaveBeenCalledOnce()
  })
})
