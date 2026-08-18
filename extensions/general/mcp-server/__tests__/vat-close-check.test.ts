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
  const standardSettings = {
    vat_taxable_base_over_40m: false,
    entity_type: 'aktiebolag' as const,
    fiscal_year_start_month: 1,
    vat_has_eu_trade: false,
    vat_filing_method: 'electronic' as const,
  }

  it('monthly: June 2026 is due 17 August 2026', () => {
    const d = computeMomsDeadline('monthly', 2026, 6, standardSettings)
    expect(d?.date).toBe('2026-08-17')
    expect(d?.label).toBe('17 augusti 2026')
  })

  it('monthly: December 2026 is due 12 February 2027', () => {
    const d = computeMomsDeadline('monthly', 2026, 12, standardSettings)
    expect(d?.date).toBe('2027-02-12')
  })

  it('monthly: filers above SEK 40 million use the 26th of the following month', () => {
    const d = computeMomsDeadline('monthly', 2026, 1, {
      ...standardSettings,
      vat_taxable_base_over_40m: true,
    })
    expect(d?.date).toBe('2026-02-26')
    expect(d?.label).toBe('26 februari 2026')
  })

  it('adjusts a raw 26 December deadline to the next banking day', () => {
    const d = computeMomsDeadline('monthly', 2026, 11, {
      ...standardSettings,
      vat_taxable_base_over_40m: true,
    })
    expect(d?.date).toBe('2026-12-28')
  })

  it.each([
    [1, '2026-05-12'],
    [2, '2026-08-17'],
    [3, '2026-11-12'],
    [4, '2027-02-12'],
  ])('quarterly: Q%s uses the canonical table', (quarter, expected) => {
    expect(computeMomsDeadline('quarterly', 2026, quarter, standardSettings)?.date)
      .toBe(expected)
  })

  it('yearly: an enskild firma with EU trade is due 26 February', () => {
    const d = computeMomsDeadline('yearly', 2026, 1, {
      ...standardSettings,
      entity_type: 'enskild_firma',
      vat_has_eu_trade: true,
    })
    expect(d?.date).toBe('2027-02-26')
  })

  it('yearly: an enskild firma does not require a filing method', () => {
    const d = computeMomsDeadline('yearly', 2026, 1, {
      ...standardSettings,
      entity_type: 'enskild_firma',
      vat_filing_method: null,
    })
    expect(d?.date).toBe('2027-05-12')
  })

  it('yearly: an AB with EU trade does not require a filing method', () => {
    const d = computeMomsDeadline('yearly', 2026, 1, {
      ...standardSettings,
      vat_has_eu_trade: true,
      vat_filing_method: null,
    })
    expect(d?.date).toBe('2027-02-26')
  })

  it('yearly: an aktiebolag uses its canonical electronic filing deadline', () => {
    const d = computeMomsDeadline('yearly', 2026, 1, standardSettings)
    expect(d?.date).toBe('2027-08-17')
  })

  it('yearly: an AB without EU trade still requires a filing method', () => {
    const d = computeMomsDeadline('yearly', 2026, 1, {
      ...standardSettings,
      vat_filing_method: null,
    })
    expect(d).toBeNull()
  })

  it('yearly: does not guess a calendar year for an AB without fiscal settings', () => {
    const d = computeMomsDeadline('yearly', 2026, 1, {
      ...standardSettings,
      fiscal_year_start_month: null,
    })
    expect(d).toBeNull()
  })
})
