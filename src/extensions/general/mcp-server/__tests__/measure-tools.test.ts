/**
 * The measure tools (generated from lib/operations/measures.ts): search-only
 * reads at no tools/list cost, the same contract as the v1 doors, typed
 * refusals through the shared error envelope, and response payloads inside
 * a small budget.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(), createServiceClient: vi.fn() }))

import { tools } from '../server'
import { isDefaultCatalogTool } from '../tool-reach'
import { getStructuredError } from '@/lib/errors/get-structured-error'
import { createFakeLedger } from '@/lib/measures/__tests__/fake-ledger'
import { CO, fixtureData } from '@/lib/measures/__tests__/fixtures'

const NAMES = ['gnubok_list_measures', 'gnubok_get_measure', 'gnubok_explain_measure']
const tool = (name: string) => tools.find((t) => t.name === name)!
const ledger = () => createFakeLedger(fixtureData()).supabase

/** Response budgets in characters of the JSON an agent receives (about 4 characters per token). */
const GET_BUDGET = 4_000
const EXPLAIN_DEFAULT_PAGE_BUDGET = 16_000

describe('measure tools', () => {
  it('exist as search-only, read-only tools with closed input schemas', () => {
    for (const name of NAMES) {
      const t = tool(name)
      expect(t, name).toBeDefined()
      expect(isDefaultCatalogTool(t), `${name} must not cost tools/list budget`).toBe(false)
      expect(t.annotations.readOnlyHint, name).toBe(true)
      expect(t.inputSchema.additionalProperties, name).toBe(false)
      expect(t.description.length, name).toBeLessThanOrEqual(280)
    }
    expect(tool('gnubok_get_measure').inputSchema.required).toEqual(['measure_id'])
  })

  it('gnubok_get_measure answers the value, its definition and the explain handle', async () => {
    const out = (await tool('gnubok_get_measure').execute(
      { measure_id: 'accounts_receivable', as_of_date: '2026-06-30' },
      CO,
      'user-1',
      ledger(),
    )) as { value: number; definition: string; explain: { tool: string; arguments: Record<string, unknown> } }
    expect(out.value).toBe(12500)
    expect(out.definition).toContain('accounts_receivable role')
    expect(out.explain).toMatchObject({
      tool: 'gnubok_explain_measure',
      arguments: { measure_id: 'accounts_receivable', as_of_date: '2026-06-30' },
    })
    expect(JSON.stringify(out).length).toBeLessThan(GET_BUDGET)
  })

  it('accepts the momsperiod as numbers or as the strings some clients send', async () => {
    const out = (await tool('gnubok_get_measure').execute(
      { measure_id: 'vat_payable', period_type: 'quarterly', year: '2026', period: '1' },
      CO,
      'user-1',
      ledger(),
    )) as { value: number }
    expect(out.value).toBe(500)
  })

  it('gnubok_explain_measure lists the journal lines with je_ handles, inside the budget', async () => {
    const out = (await tool('gnubok_explain_measure').execute(
      { measure_id: 'result_to_date', as_of_date: '2026-12-31' },
      CO,
      'user-1',
      ledger(),
    )) as { drilldown: { items: Array<{ handle: string }>; total: number }; reconciles: boolean }
    expect(out.reconciles).toBe(true)
    expect(out.drilldown.items.every((l) => /^je_[0-9a-f]{32}$/.test(l.handle))).toBe(true)
    expect(JSON.stringify(out).length).toBeLessThan(EXPLAIN_DEFAULT_PAGE_BUDGET)
  })

  it('refuses with the typed code and the Swedish sentence through the shared error envelope', async () => {
    const err = await tool('gnubok_get_measure')
      .execute({ measure_id: 'vat_payable' }, CO, 'user-1', ledger())
      .catch((e: unknown) => e)
    const envelope = getStructuredError(err)
    expect(envelope.code).toBe('MEASURE_PERIOD_REQUIRED')
    expect(envelope.message_sv).toContain('period_type')
    expect(envelope.retryable).toBe(false)
  })

  it('refuses an argument it does not declare', async () => {
    const err = await tool('gnubok_get_measure')
      .execute({ measure_id: 'liquid_funds', as_of: '2026-06-30' }, CO, 'user-1', ledger())
      .catch((e: unknown) => e)
    expect(getStructuredError(err).code).toBe('VALIDATION_ERROR')
  })

  it('gnubok_list_measures lists the ten measures', async () => {
    const out = (await tool('gnubok_list_measures').execute({}, CO, 'user-1', ledger())) as { measures: unknown[] }
    expect(out.measures).toHaveLength(10)
  })
})
