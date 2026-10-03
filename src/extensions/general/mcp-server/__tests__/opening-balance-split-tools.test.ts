/**
 * "Dela upp IB per projekt" over MCP (#3313): the read-only preview tool and
 * the staged write, both generated from the operations in
 * src/lib/operations/opening-balances.ts. Staging runs the dry run (every
 * check the commit runs) and pins the preview's fingerprint; approval
 * (commitPendingOperation) applies exactly that split through the inline
 * rättelse RPC, and refuses when the IB changed in between.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
  createServiceClient: vi.fn(),
}))

import { eventBus } from '@/lib/events'
import type { PendingOperation } from '@/types'
import { commitPendingOperation } from '@/lib/pending-operations/commit'
import { createOperationTools } from '@/extensions/general/mcp-server/operation-tools'
import { tools, isDefaultCatalogTool, isStagingTool } from '../server'
import { openingBalancesSplitPerProject, openingBalancesSplitPreview } from '@/lib/operations/opening-balances'

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const PERIOD = '7b3a0000-0000-4000-8000-000000000001'
const PREVIOUS = '7b3a0000-0000-4000-8000-000000000000'
const IB = '4d2a0000-0000-4000-8000-000000000001'
const DIM6 = 'dddd0000-0000-4000-8000-000000000006'

interface World {
  locked: boolean
  ibLines: Array<Record<string, unknown>>
}

const UNSPLIT = () => [
  { id: 'aaaa0000-0000-4000-8000-000000001470', account_number: '1470', debit_amount: 2100, credit_amount: 0, line_description: 'IB 1470', dimensions: {}, currency: 'SEK' },
  { id: 'aaaa0000-0000-4000-8000-000000002081', account_number: '2081', debit_amount: 0, credit_amount: 2100, line_description: 'IB 2081', dimensions: {}, currency: 'SEK' },
]

/** A table-keyed client over mutable state; records every call. */
function makeClient(world: World) {
  const calls: Array<{ table: string; method: string; args: unknown[] }> = []
  let periodReads = 0
  let entryReads = 0
  const answer = (table: string): unknown => {
    switch (table) {
      case 'fiscal_periods':
        periodReads += 1
        return periodReads % 2 === 1
          ? {
              data: {
                id: PERIOD,
                name: '2026',
                period_start: '2026-01-01',
                period_end: '2026-12-31',
                is_closed: false,
                locked_at: world.locked ? '2026-09-01T00:00:00Z' : null,
                opening_balances_set: true,
                opening_balance_entry_id: IB,
                previous_period_id: PREVIOUS,
              },
              error: null,
            }
          : { data: { id: PREVIOUS, name: '2025', is_closed: true, period_end: '2025-12-31' }, error: null }
      case 'journal_entries':
        entryReads += 1
        return entryReads % 2 === 1
          ? { data: { id: IB, status: 'posted', entry_date: '2026-01-01', voucher_series: 'A', voucher_number: 1 }, error: null }
          : { data: null, count: 0, error: null }
      case 'journal_entry_lines':
        return { data: world.ibLines, error: null }
      case 'dimensions':
        return { data: [{ id: DIM6, sie_dim_no: 6, resets_annually: false }], error: null }
      case 'rpc:compute_object_closing_balances':
        return { data: [{ account_number: '1470', dimensions: { '6': 'P1' }, net: 1300 }], error: null }
      case 'chart_of_accounts':
        return { data: [{ account_number: '1470', account_name: 'Pågående arbeten' }], error: null }
      case 'dimension_values':
        return { data: [{ dimension_id: DIM6, code: 'P1', name: 'Kv. Eken', is_active: true }], error: null }
      case 'company_settings':
        return { data: { bookkeeping_locked_through: null }, error: null }
      case 'rpc:correct_entry_lines_inline':
        return { data: { log_id: 'bbbb0000-0000-4000-8000-000000000001' }, error: null }
      case 'pending_operations':
        return { data: { id: 'op-1' }, error: null }
      default:
        return { data: null, error: null }
    }
  }
  const chain = (table: string): unknown =>
    new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === 'then') return (resolve: (v: unknown) => void) => resolve(answer(table))
          return (...args: unknown[]) => {
            calls.push({ table, method: String(prop), args })
            return chain(table)
          }
        },
      },
    )
  const rpc = vi.fn((name: string, args?: unknown) => {
    calls.push({ table: `rpc:${name}`, method: 'rpc', args: [args] })
    return chain(`rpc:${name}`)
  })
  return { calls, rpc, from: vi.fn((table: string) => chain(table)) }
}

const writes = (client: ReturnType<typeof makeClient>) =>
  client.calls.filter((c) => c.table === 'rpc:correct_entry_lines_inline')

async function stage(world: World) {
  const staged: { type?: string; params?: Record<string, unknown>; preview?: Record<string, unknown> } = {}
  const generated = createOperationTools([openingBalancesSplitPerProject], {
    readOnly: {},
    stagedWrite: {},
    stagedSchema: {},
    stagingArgs: {},
    stagePendingOperation: async (
      _s: unknown,
      _c: string,
      _u: string,
      type: string,
      _title: string,
      params: Record<string, unknown>,
      previewData: Record<string, unknown>,
    ) => {
      staged.type = type
      staged.params = params
      staged.preview = previewData
      return { staged: true }
    },
  } as never)
  const client = makeClient(world)
  await generated[0].execute({ fiscal_period_id: PERIOD }, COMPANY_ID, 'user-1', client as never, { type: 'api_key', id: 'key-1' } as never)
  return { staged, client }
}

function pendingOp(params: Record<string, unknown>): PendingOperation {
  return {
    id: 'op-1',
    user_id: 'user-1',
    company_id: COMPANY_ID,
    operation_type: 'split_opening_balances_per_project',
    status: 'pending',
    title: 'Dela upp ingående balanser per projekt',
    params,
    preview_data: {},
    result_data: null,
    actor_type: 'user',
    actor_id: null,
    actor_label: null,
    risk_level: 'high',
    created_at: '2026-10-03T00:00:00Z',
    resolved_at: null,
    updated_at: '2026-10-03T00:00:00Z',
  } as PendingOperation
}

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

describe('MCP tools for the IB split per project', () => {
  it('registers a search-only read preview and a search-only staged write', () => {
    const preview = tools.find((t) => t.name === 'gnubok_preview_opening_balance_split')!
    const split = tools.find((t) => t.name === 'gnubok_split_opening_balances_per_project')!
    expect(preview).toBeDefined()
    expect(split).toBeDefined()
    expect(isStagingTool(preview)).toBe(false)
    expect(isStagingTool(split)).toBe(true)
    expect(isDefaultCatalogTool(preview)).toBe(false)
    expect(isDefaultCatalogTool(split)).toBe(false)
    expect(Object.keys(split.inputSchema.properties as Record<string, unknown>)).toEqual(
      expect.arrayContaining(['fiscal_period_id', 'expected_fingerprint', 'dry_run', 'idempotency_key']),
    )
  })

  it('previews read-only: the plan per account, and nothing written', async () => {
    const [tool] = createOperationTools([openingBalancesSplitPreview], {
      readOnly: {},
      stagedWrite: {},
      stagedSchema: {},
      stagingArgs: {},
      stagePendingOperation: vi.fn(),
    } as never)
    const client = makeClient({ locked: false, ibLines: UNSPLIT() })
    const result = (await tool.execute({ fiscal_period_id: PERIOD }, COMPANY_ID, 'user-1', client as never)) as {
      accounts_to_change: number
      can_apply: boolean
      accounts: Array<{ account_number: string; proposed_lines: Array<{ amount: number; dimensions: Record<string, string> }> }>
    }
    expect(result.accounts_to_change).toBe(1)
    expect(result.can_apply).toBe(true)
    expect(result.accounts[0].proposed_lines.map((l) => [l.dimensions['6'] ?? '', l.amount])).toEqual([
      ['P1', 1300],
      ['', 800],
    ])
    expect(writes(client)).toHaveLength(0)
  })

  it('stages with the preview\'s fingerprint pinned, without writing', async () => {
    const { staged, client } = await stage({ locked: false, ibLines: UNSPLIT() })
    expect(staged.type).toBe('split_opening_balances_per_project')
    expect(staged.params).toEqual({ fiscal_period_id: PERIOD, expected_fingerprint: staged.preview!.fingerprint })
    expect(staged.preview).toMatchObject({ accounts_to_change: 1, method: 'inline_rattelse' })
    expect(writes(client)).toHaveLength(0)
  })

  it('refuses to stage for a locked year, with the code the commit would answer', async () => {
    await expect(stage({ locked: true, ibLines: UNSPLIT() })).rejects.toMatchObject({ code: 'OB_SPLIT_PERIOD_LOCKED' })
  })

  it('approval applies exactly the staged split through the inline rättelse', async () => {
    const world = { locked: false, ibLines: UNSPLIT() }
    const { staged } = await stage(world)
    const client = makeClient(world)
    const result = await commitPendingOperation(client as never, 'user-1', COMPANY_ID, pendingOp(staged.params!))
    expect(result.status).toBe('committed')
    expect(result.data).toMatchObject({ applied: true, accounts_changed: ['1470'], journal_entry_id: IB })
    const [call] = writes(client)
    expect(call.args[0]).toMatchObject({
      p_entry_id: IB,
      p_strike_line_ids: ['aaaa0000-0000-4000-8000-000000001470'],
      p_user_id: 'user-1',
    })
  })

  it('approval refuses OB_SPLIT_PROPOSAL_CHANGED when the IB changed after staging', async () => {
    const world = { locked: false, ibLines: UNSPLIT() }
    const { staged } = await stage(world)
    world.ibLines = [
      { ...UNSPLIT()[0], debit_amount: 2500 },
      { ...UNSPLIT()[1], credit_amount: 2500 },
    ]
    const client = makeClient(world)
    const result = await commitPendingOperation(client as never, 'user-1', COMPANY_ID, pendingOp(staged.params!))
    expect(result.code).toBe('OB_SPLIT_PROPOSAL_CHANGED')
    expect(writes(client)).toHaveLength(0)
  })
})
