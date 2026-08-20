import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { AgentTool } from '@/lib/agent/tools/types'

const getMany = vi.fn()
vi.mock('@/lib/agent/tools/registry', () => ({
  agentToolRegistry: { getMany: (names: string[]) => getMany(names) },
}))

import { buildLedgerTools, LEDGER_READ_TOOLS } from '../ledger-tools'

function tool(name: string, ann?: AgentTool['annotations']): AgentTool {
  return {
    name,
    description: `desc ${name}`,
    inputSchema: { type: 'object', properties: {} },
    ...(ann ? { annotations: ann } : {}),
    execute: vi.fn().mockResolvedValue({ tool: name }),
  }
}

const supabase = {} as SupabaseClient

beforeEach(() => vi.clearAllMocks())

describe('buildLedgerTools', () => {
  it('requests exactly the read whitelist from the registry', () => {
    getMany.mockReturnValue([])
    buildLedgerTools(supabase, 'c1', 'u1')
    expect(getMany).toHaveBeenCalledWith([...LEDGER_READ_TOOLS])
  })

  it('keeps read-only + unannotated tools, drops writable/destructive ones', () => {
    getMany.mockReturnValue([
      tool('gnubok_get_income_statement', { readOnlyHint: true }),
      tool('gnubok_list_accounts'), // unannotated: on the curated read whitelist, kept
      tool('gnubok_categorize_transaction', { readOnlyHint: false }),
      tool('gnubok_delete_voucher', { destructiveHint: true }),
    ])
    const defs = buildLedgerTools(supabase, 'c1', 'u1')
    expect(defs.map((d) => d.name)).toEqual(['gnubok_get_income_statement', 'gnubok_list_accounts'])
  })

  it('adapts each tool: name/description/jsonSchema and an execute bound to the actor', async () => {
    const src = tool('gnubok_get_vat_report', { readOnlyHint: true })
    getMany.mockReturnValue([src])
    const defs = buildLedgerTools(supabase, 'company-9', 'user-7', 'conv-3')
    expect(defs).toHaveLength(1)
    const def = defs[0]
    expect(def.name).toBe('gnubok_get_vat_report')
    expect(def.description).toBe('desc gnubok_get_vat_report')
    expect(def.jsonSchema).toEqual({ type: 'object', properties: {} })

    const out = await def.execute({ period: '2026-07' })
    expect(out).toEqual({ tool: 'gnubok_get_vat_report' })
    expect(src.execute).toHaveBeenCalledWith(
      { period: '2026-07' },
      'company-9',
      'user-7',
      supabase,
      { type: 'agent_chat', id: 'conv-3' },
    )
  })

  it('omits the actor id when there is no conversation', async () => {
    const src = tool('gnubok_get_trial_balance', { readOnlyHint: true })
    getMany.mockReturnValue([src])
    const [def] = buildLedgerTools(supabase, 'c1', 'u1')
    await def.execute({})
    expect(src.execute).toHaveBeenCalledWith({}, 'c1', 'u1', supabase, { type: 'agent_chat' })
  })

  it('returns nothing when the registry is empty (core-only build)', () => {
    getMany.mockReturnValue([])
    expect(buildLedgerTools(supabase, 'c1', 'u1')).toEqual([])
  })

  it('never lists a write or memory-write tool on the whitelist', () => {
    for (const bad of [
      'gnubok_categorize_transaction',
      'gnubok_create_invoice',
      'gnubok_approve_supplier_invoice',
      'gnubok_remember_fact',
      'gnubok_forget_fact',
    ]) {
      expect(LEDGER_READ_TOOLS).not.toContain(bad)
    }
  })
})
