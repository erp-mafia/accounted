/**
 * Unit tests for gnubok_vat_close_check.
 *
 * Covers tool registration, scope mapping, the pure Skatteverket deadline math,
 * and the basic output shape. The full multi-query integration is tested via
 * the manual MCP smoke test described in the plan; mocking every chained
 * supabase call here would couple tests to internal query order.
 */
import { describe, it, expect } from 'vitest'
import { tools, computeMomsDeadline, UNCATEGORIZED_TRANSACTIONS_HINT } from '../server'
import { TOOL_SCOPE_MAP } from '@/lib/auth/api-keys'

describe('gnubok_vat_close_check', () => {
  it('is registered in the tools array', () => {
    const tool = tools.find((t) => t.name === 'gnubok_vat_close_check')
    expect(tool).toBeDefined()
    expect(tool?.annotations.readOnlyHint).toBe(true)
    expect(tool?.annotations.idempotentHint).toBe(true)
    expect(tool?.annotations.destructiveHint).toBe(false)
  })

  it('has the required input schema', () => {
    const tool = tools.find((t) => t.name === 'gnubok_vat_close_check')!
    const schema = tool.inputSchema as { required?: string[]; properties?: Record<string, unknown> }
    expect(schema.required).toEqual(['period_type', 'year', 'period'])
    expect(schema.properties).toHaveProperty('period_type')
    expect(schema.properties).toHaveProperty('year')
    expect(schema.properties).toHaveProperty('period')
  })

  it('declares an output schema with all the intent fields', () => {
    const tool = tools.find((t) => t.name === 'gnubok_vat_close_check')!
    const schema = tool.outputSchema as { required?: string[] }
    expect(schema.required).toContain('rutor')
    expect(schema.required).toContain('payment')
    expect(schema.required).toContain('blockers')
    expect(schema.required).toContain('sanity')
    expect(schema.required).toContain('ready_to_close')
    expect(schema.required).toContain('summary')
  })

  it('is mapped to reports:read scope', () => {
    expect(TOOL_SCOPE_MAP.gnubok_vat_close_check).toBe('reports:read')
  })

  it('uncategorized-transactions hint offers both resolution paths', () => {
    // The blocker must not steer agents into double-booking: a transaction
    // whose affärshändelse is already booked needs the link tool, not a new
    // booking via categorize/auto-match. An agent that only sees the booking
    // tools concludes linking requires support intervention.
    expect(UNCATEGORIZED_TRANSACTIONS_HINT).toContain('gnubok_categorize_transaction')
    expect(UNCATEGORIZED_TRANSACTIONS_HINT).toContain('gnubok_auto_match_period')
    expect(UNCATEGORIZED_TRANSACTIONS_HINT).toContain('gnubok_link_transaction_to_journal_entry')
  })
})

describe('computeMomsDeadline', () => {
  it('monthly: March 2026 → 12 April 2026', () => {
    const d = computeMomsDeadline('monthly', 2026, 3)
    expect(d?.date).toBe('2026-04-12')
    expect(d?.label).toBe('12 april 2026')
  })

  it('monthly: December rolls into next year', () => {
    const d = computeMomsDeadline('monthly', 2026, 12)
    expect(d?.date).toBe('2027-01-12')
  })

  it('quarterly: Q1 2026 → 26 April 2026', () => {
    const d = computeMomsDeadline('quarterly', 2026, 1)
    expect(d?.date).toBe('2026-04-26')
  })

  it('quarterly: Q4 2026 → 26 January 2027', () => {
    const d = computeMomsDeadline('quarterly', 2026, 4)
    expect(d?.date).toBe('2027-01-26')
  })

  it('yearly: 2026 → 26 February 2027', () => {
    const d = computeMomsDeadline('yearly', 2026, 1)
    expect(d?.date).toBe('2027-02-26')
  })
})
