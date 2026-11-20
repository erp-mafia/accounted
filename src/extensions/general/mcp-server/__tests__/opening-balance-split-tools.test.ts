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
  /** Project codes with a 1470 balance last year (default: P1 1300). */
  projects?: string[]
  /** The 1-based inline rättelse call that fails; the others are applied to ibLines. */
  failRattelseCall?: number
  rattelseCalls?: number
}

const ALREADY_SPLIT = () => [
  { id: 'aaaa0000-0000-4000-8000-000000000001', account_number: '1470', debit_amount: 1300, credit_amount: 0, line_description: null, dimensions: { '6': 'P1' }, currency: 'SEK' },
  { id: 'aaaa0000-0000-4000-8000-000000000002', account_number: '1470', debit_amount: 800, credit_amount: 0, line_description: null, dimensions: {}, currency: 'SEK' },
  { id: 'aaaa0000-0000-4000-8000-000000002081', account_number: '2081', debit_amount: 0, credit_amount: 2100, line_description: null, dimensions: {}, currency: 'SEK' },
]

/** correct_entry_lines_inline applied to the world's IB lines (no guards: the service's input is checked elsewhere). */
function applyRattelse(world: World, args: { p_strike_line_ids: string[]; p_new_lines: Array<Record<string, unknown>> }) {
  world.rattelseCalls = (world.rattelseCalls ?? 0) + 1
  const n = world.rattelseCalls
  if (world.failRattelseCall === n) {
    return { data: null, error: { code: '57014', message: 'canceling statement due to statement timeout' } }
  }
  const strike = new Set(args.p_strike_line_ids)
  world.ibLines = [
    ...world.ibLines.filter((line) => !strike.has(line.id as string)),
    ...args.p_new_lines.map((line, i) => ({ ...line, id: `cccc0000-0000-4000-8000-${String(n * 1000 + i).padStart(12, '0')}`, currency: 'SEK' })),
  ]
  return { data: { log_id: `bbbb0000-0000-4000-8000-${String(n).padStart(12, '0')}` }, error: null }
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
  let lastRattelse: unknown = null
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
        return world.projects
          ? { data: world.projects.map((code) => ({ account_number: '1470', dimensions: { '6': code }, net: 10 })), error: null }
          : { data: [{ account_number: '1470', dimensions: { '6': 'P1' }, net: 1300 }], error: null }
      case 'chart_of_accounts':
        return { data: [{ account_number: '1470', account_name: 'Pågående arbeten' }], error: null }
      case 'dimension_values':
        return {
          data: (world.projects ?? ['P1']).map((code) => ({ dimension_id: DIM6, code, name: `Projekt ${code}`, is_active: true })),
          error: null,
        }
      case 'company_settings':
        return { data: { bookkeeping_locked_through: null }, error: null }
      case 'rpc:correct_entry_lines_inline':
        return lastRattelse ?? { data: { log_id: 'bbbb0000-0000-4000-8000-000000000001' }, error: null }
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
    if (name === 'correct_entry_lines_inline' && world.projects) {
      lastRattelse = applyRattelse(world, args as { p_strike_line_ids: string[]; p_new_lines: Array<Record<string, unknown>> })
    }
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

  it('refuses to stage a split that would change nothing: no no-op lands in /pending', async () => {
    let staged = false
    const [tool] = createOperationTools([openingBalancesSplitPerProject], {
      readOnly: {},
      stagedWrite: {},
      stagedSchema: {},
      stagingArgs: {},
      stagePendingOperation: async () => {
        staged = true
        return { staged: true }
      },
    } as never)
    // Already split, even in a locked year: nothing to stage, not "locked".
    for (const locked of [false, true]) {
      const client = makeClient({ locked, ibLines: ALREADY_SPLIT() })
      await expect(
        tool.execute({ fiscal_period_id: PERIOD }, COMPANY_ID, 'user-1', client as never, { type: 'api_key', id: 'key-1' } as never),
      ).rejects.toMatchObject({ code: 'OB_SPLIT_NOTHING_TO_DO' })
      expect(writes(client)).toHaveLength(0)
    }
    expect(staged).toBe(false)
  })

  it('stages the amount the unattended-commit ceiling prices', async () => {
    const { staged } = await stage({ locked: false, ibLines: UNSPLIT() })
    expect(staged.preview!.changed_amount_sek).toBe(2100)
  })

  it('an approval that fails after an inline rättelse committed lands in failed_partial with what was applied', async () => {
    const projects = Array.from({ length: 120 }, (_, i) => `P${String(i + 1).padStart(3, '0')}`)
    const world: World = { locked: false, ibLines: UNSPLIT(), projects }
    const { staged } = await stage(world)
    world.failRattelseCall = 2
    world.rattelseCalls = 0
    const client = makeClient(world)
    const result = await commitPendingOperation(client as never, 'user-1', COMPANY_ID, pendingOp(staged.params!))

    expect(writes(client)).toHaveLength(2)
    expect(result).toMatchObject({
      status: 'failed',
      code: 'partial_commit',
      operation_status: 'failed_partial',
      data: {
        posted_ids: {
          journal_entry_id: IB,
          rattelse_log_ids: 'bbbb0000-0000-4000-8000-000000000001',
          accounts_changed: '1470',
        },
      },
    })
    const update = client.calls.find(
      (c) => c.table === 'pending_operations' && c.method === 'update' && (c.args[0] as { status?: string }).status === 'failed_partial',
    )
    expect(update).toBeDefined()
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
