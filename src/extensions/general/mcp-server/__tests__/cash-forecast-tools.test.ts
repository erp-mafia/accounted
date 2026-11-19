/**
 * The liquidity forecast over MCP (lib/operations/cash-forecast.ts): the
 * forecast and the row list are reads; the row writes are not bookkeeping,
 * so they commit on the call under forecast:write (OperationMcpBinding.direct,
 * decision 2026-10-28) instead of staging, replay idempotency_key, and record
 * the row's source as mcp. All four are search-only: tools/list is at its
 * ceiling.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/lib/supabase/server', () => ({ createClient: vi.fn(), createServiceClient: vi.fn() }))

import { TOOL_SCOPE_MAP } from '@/lib/auth/scope-catalog'
import { createTableMockSupabase } from '@/tests/helpers'
import { isStagingTool, tools } from '../server'

const COMPANY_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const tool = (name: string) => {
  const found = tools.find((t) => t.name === name)
  if (!found) throw new Error(`${name} is not registered`)
  return found
}

describe('cash forecast MCP tools', () => {
  it('reads the forecast and the rows with reports:read, search-only', () => {
    for (const name of ['gnubok_get_cash_forecast', 'gnubok_list_cash_forecast_rows']) {
      expect(tool(name).annotations.readOnlyHint, name).toBe(true)
      expect(tool(name).catalogVisibility, name).toBe('search')
      expect(TOOL_SCOPE_MAP[name], name).toBe('reports:read')
    }
  })

  it('writes rows directly under forecast:write: no staging, idempotent, search-only', () => {
    for (const name of ['gnubok_upsert_cash_forecast_rows', 'gnubok_cancel_cash_forecast_row']) {
      const t = tool(name)
      expect(isStagingTool(t), name).toBe(false)
      expect(t.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: true })
      expect(t.retryKey, name).toBe(true)
      expect(t.catalogVisibility, name).toBe('search')
      expect(TOOL_SCOPE_MAP[name], name).toBe('forecast:write')
      expect(t.description, name).not.toMatch(/\bstage/i)
      expect(t.inputSchema.additionalProperties, name).toBe(false)
    }
  })

  it('commits an upsert on the call and records the row as written over MCP', async () => {
    const written = {
      id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
      expected_date: '2026-11-20',
      amount: '48000.00',
      direction: 'in',
      currency: 'SEK',
      category: 'revenue',
      source: 'mcp',
      external_source: 'agent',
      external_id: 'rent-2026-11',
      confidence: 'firm',
      dimension_value_id: null,
      invoice_id: null,
      supplier_invoice_id: null,
      status: 'open',
      matched_transaction_id: null,
      note: 'Hyra november',
      created_at: '2026-10-28T09:00:00Z',
      updated_at: '2026-10-28T09:00:00Z',
    }
    const { supabase, payloads, calls } = createTableMockSupabase({
      cash_forecast_rows: { data: [] },
      'rpc:upsert_cash_forecast_rows': { data: [written] },
    })
    const result = (await tool('gnubok_upsert_cash_forecast_rows').execute(
      {
        rows: [
          { external_source: 'agent', external_id: 'rent-2026-11', expected_date: '2026-11-20', amount: 48000, direction: 'in', category: 'revenue', confidence: 'firm', note: 'Hyra november' },
        ],
      },
      COMPANY_ID,
      'user-1',
      supabase as never,
    )) as Record<string, unknown>
    expect(result).toMatchObject({ created: 1, updated: 0, skipped: [], rows: [expect.objectContaining({ cash_forecast_row_id: written.id, source: 'mcp' })] })
    expect(payloads('rpc:upsert_cash_forecast_rows', 'rpc')).toEqual([
      expect.objectContaining({ p_company_id: COMPANY_ID, p_source: 'mcp', p_created_by: 'user-1', p_rows: [expect.objectContaining({ amount: 48000 })] }),
    ])
    expect(calls.some((c) => c.table === 'pending_operations')).toBe(false)
  })

  it('refuses a cancel that names no row as a validation error, before any read', async () => {
    const { supabase, calls } = createTableMockSupabase({})
    await expect(
      tool('gnubok_cancel_cash_forecast_row').execute({ external_source: 'agent' }, COMPANY_ID, 'user-1', supabase as never),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(calls).toEqual([])
  })
})
