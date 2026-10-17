/**
 * The unexplained tools (generated from lib/operations/unexplained.ts):
 * search-only reads at no tools/list cost, typed refusals through the shared
 * error envelope, response payloads inside a small budget, and the agent
 * briefing's compact block (a count and the top rows, never the list).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(), createServiceClient: vi.fn() }))
// The SIE import lease has its own tests (lib/import/__tests__/sie-period-read.test.ts).
vi.mock('@/lib/import/sie-period-read', async () => {
  const actual = await vi.importActual<typeof import('@/lib/import/sie-period-read')>('@/lib/import/sie-period-read')
  return {
    ...actual,
    withSIEExternalReport: (_s: unknown, _c: unknown, _op: unknown, read: () => Promise<unknown>) => read(),
  }
})

import { tools } from '../server'
import { isDefaultCatalogTool } from '../tool-reach'
import { getStructuredError } from '@/lib/errors/get-structured-error'
import { createFakeLedger } from '@/lib/measures/__tests__/fake-ledger'
import { CA_1930, CO, checkFixture, unbookedRow } from '@/lib/unexplained/__tests__/fixtures'

const NAMES = ['gnubok_list_unexplained', 'gnubok_get_unexplained', 'gnubok_explain_unexplained']
const tool = (name: string) => tools.find((t) => t.name === name)!
const ledger = (options: Parameters<typeof checkFixture>[0] = {}) => createFakeLedger(checkFixture(options)).supabase

/** Response budgets in characters of the JSON an agent receives (about 4 characters per token). */
const LIST_BUDGET = 8_000
const ROW_BUDGET = 1_000
const GET_BUDGET = 8_000
const EXPLAIN_DEFAULT_PAGE_BUDGET = 16_000
const BRIEFING_BLOCK_BUDGET = 1_500

beforeAll(() => {
  // The fixture's räkenskapsår is 2026: the checks read "today".
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-16T10:00:00.000Z'))
})
afterAll(() => {
  vi.useRealTimers()
})

describe('unexplained tools', () => {
  it('exist as search-only, read-only tools with closed input schemas', () => {
    for (const name of NAMES) {
      const t = tool(name)
      expect(t, name).toBeDefined()
      expect(isDefaultCatalogTool(t), `${name} must not cost tools/list budget`).toBe(false)
      expect(t.annotations.readOnlyHint, name).toBe(true)
      expect(t.inputSchema.additionalProperties, name).toBe(false)
      expect(t.description.length, name).toBeLessThanOrEqual(280)
    }
    expect(tool('gnubok_get_unexplained').inputSchema.required).toEqual(['check_id'])
    expect(tool('gnubok_explain_unexplained').inputSchema.required).toEqual(['check_id'])
  })

  it('gnubok_list_unexplained answers the queue with counts, fixes and explain handles, inside the budget', async () => {
    const out = (await tool('gnubok_list_unexplained').execute({}, CO, 'user-1', ledger())) as {
      counts: Record<string, number>
      items: Array<{ check_id: string; status: string; explain: { tool: string; arguments: Record<string, unknown> } }>
    }
    expect(out.counts).toEqual({ unexplained: 2, cannot_check: 2, ok: 4 })
    expect(out.items[0]).toMatchObject({ check_id: 'receivables_vs_ledger', status: 'unexplained' })
    expect(out.items[0].explain).toEqual(expect.objectContaining({ tool: 'gnubok_explain_unexplained', arguments: { check_id: 'receivables_vs_ledger' } }))
    expect(JSON.stringify(out).length).toBeLessThan(LIST_BUDGET)
    for (const row of out.items) expect(JSON.stringify(row).length, row.check_id).toBeLessThan(ROW_BUDGET)
  })

  it('gnubok_get_unexplained answers the definition, basis and both figures per result', async () => {
    const out = (await tool('gnubok_get_unexplained').execute({ check_id: 'bank_balance_vs_bank' }, CO, 'user-1', ledger())) as {
      basis: string
      results: Array<{ status: string; sides: Array<{ amount: number | null }>; explain: { arguments: Record<string, unknown> } }>
    }
    expect(out.basis).toContain('swedish-year-end-closing')
    expect(out.results[0]).toMatchObject({ status: 'ok', sides: [{ amount: 55350 }, { amount: 55350 }] })
    expect(out.results[0].explain.arguments).toEqual({ check_id: 'bank_balance_vs_bank', cash_account_id: CA_1930 })
    expect(JSON.stringify(out).length).toBeLessThan(GET_BUDGET)
  })

  it('gnubok_explain_unexplained names the records behind a difference with typed handles, inside the budget', async () => {
    const supabase = ledger({ bankBalance: { amount: 56350, at: '2026-06-30T10:00:00.000Z' }, transactions: [unbookedRow()] })
    const out = (await tool('gnubok_explain_unexplained').execute(
      { check_id: 'bank_balance_vs_bank', cash_account_id: CA_1930 },
      CO,
      'user-1',
      supabase,
    )) as { difference: number; items: { list: Array<{ handle: string }>; total: number }; reconciles: boolean }
    expect(out).toMatchObject({ difference: 1000, reconciles: true, items: { total: 1 } })
    expect(out.items.list[0].handle).toMatch(/^txn_[0-9a-f]{32}$/)
    expect(JSON.stringify(out).length).toBeLessThan(EXPLAIN_DEFAULT_PAGE_BUDGET)
  })

  it('pages the items: the default page stays inside the budget however many rows there are', async () => {
    const rows = Array.from({ length: 120 }, (_, i) =>
      unbookedRow({ id: `d0000000-0000-4000-8000-${String(i + 10).padStart(12, '0')}`, date: '2026-05-01', description: `Kortköp ${i}` }),
    )
    const out = (await tool('gnubok_explain_unexplained').execute(
      { check_id: 'unbooked_bank_lines_overdue' },
      CO,
      'user-1',
      ledger({ transactions: rows }),
    )) as { difference: number; items: { list: unknown[]; total: number; next_offset: number | null } }
    expect(out.difference).toBe(120)
    expect(out.items).toMatchObject({ total: 120, next_offset: 25 })
    expect(out.items.list).toHaveLength(25)
    expect(JSON.stringify(out).length).toBeLessThan(EXPLAIN_DEFAULT_PAGE_BUDGET)
  })

  it('accepts the momsperiod as numbers or as the strings some clients send', async () => {
    const out = (await tool('gnubok_explain_unexplained').execute(
      { check_id: 'vat_declared_not_settled', period_type: 'quarterly', year: '2026', period: '2' },
      CO,
      'user-1',
      ledger(),
    )) as { difference: number }
    expect(out.difference).toBe(1150)
  })

  it('refuses with the typed code and the Swedish sentence through the shared error envelope', async () => {
    const err = await tool('gnubok_explain_unexplained')
      .execute({ check_id: 'bank_balance_vs_bank' }, CO, 'user-1', ledger())
      .catch((e: unknown) => e)
    const envelope = getStructuredError(err)
    expect(envelope.code).toBe('UNEXPLAINED_SUBJECT_REQUIRED')
    expect(envelope.message_sv).toContain('cash_account_id')
    expect(envelope.retryable).toBe(false)
  })

  it('refuses an argument it does not declare', async () => {
    const err = await tool('gnubok_get_unexplained')
      .execute({ check_id: 'payables_vs_ledger', as_of_date: '2026-06-30' }, CO, 'user-1', ledger())
      .catch((e: unknown) => e)
    expect(getStructuredError(err).code).toBe('VALIDATION_ERROR')
  })
})

describe('the agent briefing block', () => {
  it('carries the count, the cannot_check count and the top rows, never the full list', async () => {
    const briefing = tool('gnubok_get_agent_briefing')
    const out = (await briefing.execute({}, CO, 'user-1', ledger(), { type: 'api_key' })) as {
      unexplained: { tool: string; unexplained: number; cannot_check: number; top: Array<{ check_id: string; difference: number }>; how: string }
    }
    expect(out.unexplained).toMatchObject({ tool: 'gnubok_list_unexplained', unexplained: 2, cannot_check: 2 })
    expect(out.unexplained.top.map((t) => [t.check_id, t.difference])).toEqual([
      ['receivables_vs_ledger', 3000],
      ['vat_declared_not_settled', 1150],
    ])
    expect(out.unexplained.how).toContain('gnubok_explain_unexplained')
    expect(tools.some((t) => t.name === out.unexplained.tool)).toBe(true)
    expect(JSON.stringify(out.unexplained).length).toBeLessThan(BRIEFING_BLOCK_BUDGET)
    expect(JSON.stringify(out.unexplained)).not.toContain('"items"')
  })

  it('counts checks whose source failed as cannot_check, never as ok', async () => {
    const denied = { message: 'permission denied', code: '42501' }
    const failing = createFakeLedger(checkFixture(), { tables: { cash_accounts: denied, deadlines: denied } }).supabase
    const out = (await tool('gnubok_get_agent_briefing').execute({}, CO, 'user-1', failing, { type: 'api_key' })) as {
      unexplained: { tool: string; unexplained: number; cannot_check: number }
    }
    // The bank and VAT checks could not read their source; the skattekonto is not connected.
    expect(out.unexplained).toMatchObject({ tool: 'gnubok_list_unexplained', unexplained: 1, cannot_check: 3 })
  })
})
