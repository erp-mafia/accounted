/**
 * Unit tests for gnubok_ignore_transaction (issue #1661): registration,
 * scope/risk/catalog wiring, the booked-row refusal through the shared core,
 * and staging (dry run + persisted). Executor-side coverage
 * (commitIgnoreTransaction) lives in
 * lib/pending-operations/__tests__/ignore-transaction-executor.test.ts.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createQueuedMockSupabase } from '@/tests/helpers'
import { tools, isDefaultCatalogTool } from '../server'
import { RECOMMENDED_WORKFLOW_LOADOUTS } from '../recommended-tools'
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'
import { OPERATION_RISK_TIERS } from '@/lib/pending-operations/risk-tiers'

const tool = tools.find((t) => t.name === 'gnubok_ignore_transaction')!

const TX_ID = '00000000-0000-4000-8000-0000000000aa'
const TX_ROW = {
  id: TX_ID,
  description: 'SWISH DUBBLETT',
  merchant_name: null,
  amount: -250,
  currency: 'SEK',
  date: '2025-11-15',
  is_ignored: false,
}
const CORE_ROW = { id: TX_ID, journal_entry_id: null, is_ignored: false }

const noopSupabase = { from: vi.fn() } as never

/** Tool fetch + shared-core fetch + the three junction lookups. */
function enqueueUnbooked(
  enqueue: (r: { data?: unknown; error?: unknown }) => void,
  overrides: { tool?: Record<string, unknown>; core?: Record<string, unknown> } = {},
) {
  enqueue({ data: { ...TX_ROW, ...overrides.tool } })
  enqueue({ data: { ...CORE_ROW, ...overrides.core } })
  enqueue({ data: [] }) // transaction_voucher_links
  enqueue({ data: [] }) // invoice_payments
  enqueue({ data: [] }) // supplier_invoice_payments
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('gnubok_ignore_transaction: registration', () => {
  it('is registered in the DEFAULT catalog (a search-only write is uncallable on Claude.ai)', () => {
    expect(tool).toBeDefined()
    expect(isDefaultCatalogTool(tool)).toBe(true)
    expect((tool.inputSchema as { additionalProperties?: boolean }).additionalProperties).toBe(false)
    expect((tool.inputSchema as { required?: string[] }).required).toEqual(['transaction_id'])
    const out = tool.outputSchema as { properties?: Record<string, unknown>; required?: string[] }
    expect(out?.required).toContain('staged')
    expect(tool.description).toMatch(/TX_CATEGORIZE_PRIVATE_PERIOD_LOCKED/)
  })

  it('is mapped to transactions:write and the low risk tier', () => {
    expect(TOOL_SCOPE_MAP.gnubok_ignore_transaction).toBe('transactions:write')
    expect(OPERATION_RISK_TIERS.ignore_transaction).toBe('low')
  })

  it('is part of the categorize, close-period and reconcile loadouts', () => {
    const byWorkflow = new Map(RECOMMENDED_WORKFLOW_LOADOUTS.map((l) => [l.workflow, l.tools]))
    for (const workflow of ['categorize_month', 'close_period', 'reconcile_month']) {
      expect(byWorkflow.get(workflow), workflow).toContain('gnubok_ignore_transaction')
    }
  })
})

describe('gnubok_ignore_transaction: validation gates', () => {
  it('rejects a missing transaction_id before any DB call', async () => {
    await expect(
      tool.execute({ transaction_id: '' }, 'company-1', 'user-1', noopSupabase),
    ).rejects.toThrow(/transaction_id/)
    expect((noopSupabase as { from: ReturnType<typeof vi.fn> }).from).not.toHaveBeenCalled()
  })

  it('rejects when the transaction does not exist in this company', async () => {
    const { supabase, enqueue } = createQueuedMockSupabase()
    enqueue({ data: null })
    await expect(
      tool.execute({ transaction_id: TX_ID }, 'company-1', 'user-1', supabase as never),
    ).rejects.toThrow(/not found/i)
  })

  it('refuses a directly booked row with TX_IGNORE_ALREADY_BOOKED', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: TX_ROW })
    enqueue({ data: { ...CORE_ROW, journal_entry_id: 'je-1' } })
    await expect(
      tool.execute({ transaction_id: TX_ID }, 'company-1', 'user-1', supabase as never),
    ).rejects.toThrow(/TX_IGNORE_ALREADY_BOOKED/)
    expect(findCalls('pending_operations', 'insert')).toEqual([])
  })

  it('refuses a bulk-booked row anchored only through transaction_voucher_links', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: TX_ROW })
    enqueue({ data: CORE_ROW })
    enqueue({ data: [{ transaction_id: TX_ID }] }) // voucher links
    enqueue({ data: [] })
    enqueue({ data: [] })
    await expect(
      tool.execute({ transaction_id: TX_ID }, 'company-1', 'user-1', supabase as never),
    ).rejects.toThrow(/TX_IGNORE_ALREADY_BOOKED/)
    expect(findCalls('pending_operations', 'insert')).toEqual([])
  })
})

describe('gnubok_ignore_transaction: staging', () => {
  it('dry run previews the flip, marks period lock as not applicable, and writes nothing', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueueUnbooked(enqueue)
    enqueue({ data: null }) // resolvePeriodStatusForDate: company_settings
    enqueue({ data: null }) // resolvePeriodStatusForDate: fiscal_periods

    const result = (await tool.execute(
      { transaction_id: TX_ID, dry_run: true },
      'company-1', 'user-1', supabase as never, { type: 'user' },
    )) as { staged: boolean; dry_run?: boolean; risk_level: string; preview: Record<string, unknown> }

    expect(result.staged).toBe(false)
    expect(result.dry_run).toBe(true)
    expect(result.risk_level).toBe('low')
    expect(result.preview).toMatchObject({
      transaction_id: TX_ID,
      transaction_description: 'SWISH DUBBLETT',
      amount: -250,
      currently_ignored: false,
      will_be_ignored: true,
      already_in_state: false,
      writes_verifikat: false,
      period_lock_applies: false,
    })
    expect(findCalls('transactions', 'update')).toEqual([])
    expect(findCalls('pending_operations', 'insert')).toEqual([])
  })

  it('stages an ignore_transaction operation with { transaction_id, ignored: true } params', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueueUnbooked(enqueue)
    enqueue({ data: null }) // company_settings
    enqueue({ data: null }) // fiscal_periods
    enqueue({ data: { id: 'op-1' }, error: null }) // pending_operations insert

    const result = (await tool.execute(
      { transaction_id: TX_ID },
      'company-1', 'user-1', supabase as never, { type: 'user' },
    )) as { staged: boolean; operation_id?: string; next?: { tool: string } }

    expect(result.staged).toBe(true)
    expect(result.operation_id).toBe('op-1')
    expect(result.next?.tool).toBe('gnubok_list_uncategorized_transactions')
    const inserts = findCalls('pending_operations', 'insert')
    expect(inserts).toHaveLength(1)
    expect(inserts[0][0]).toMatchObject({
      operation_type: 'ignore_transaction',
      title: 'Ignorera transaktion: SWISH DUBBLETT',
      params: { transaction_id: TX_ID, ignored: true },
    })
    // Staging never flips the flag itself: that is the executor's job.
    expect(findCalls('transactions', 'update')).toEqual([])
  })

  it('restore: true stages ignored: false without the booked check and points back at categorize', async () => {
    const { supabase, enqueue, findCalls } = createQueuedMockSupabase()
    enqueue({ data: { ...TX_ROW, is_ignored: true } }) // tool fetch
    enqueue({ data: { ...CORE_ROW, is_ignored: true } }) // core fetch (no junction lookups on restore)
    enqueue({ data: null }) // company_settings
    enqueue({ data: null }) // fiscal_periods
    enqueue({ data: { id: 'op-2' }, error: null }) // insert

    const result = (await tool.execute(
      { transaction_id: TX_ID, restore: true },
      'company-1', 'user-1', supabase as never, { type: 'user' },
    )) as { staged: boolean; preview: Record<string, unknown>; next?: { tool: string } }

    expect(result.staged).toBe(true)
    expect(result.preview).toMatchObject({ currently_ignored: true, will_be_ignored: false })
    expect(result.next?.tool).toBe('gnubok_categorize_transaction')
    expect(findCalls('transaction_voucher_links', 'select')).toEqual([])
    expect(findCalls('pending_operations', 'insert')[0][0]).toMatchObject({
      title: 'Återställ ignorerad transaktion: SWISH DUBBLETT',
      params: { transaction_id: TX_ID, ignored: false },
    })
  })
})
