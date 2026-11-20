import { describe, it, expect } from 'vitest'
import { isReadOnlyTool } from '../read-only-tools'
import { getIntent } from '@/lib/agent/intents/registry'

describe('isReadOnlyTool', () => {
  it('keeps read tools and discovery', () => {
    expect(isReadOnlyTool('gnubok_query_journal')).toBe(true)
    expect(isReadOnlyTool('gnubok_get_income_statement')).toBe(true)
    expect(isReadOnlyTool('gnubok_load_skill')).toBe(true)
  })

  it('drops tools that stage or write', () => {
    expect(isReadOnlyTool('gnubok_categorize_transaction')).toBe(false)
    expect(isReadOnlyTool('gnubok_remember_fact')).toBe(false)
  })

  it('drops the bridges and fails closed on an unknown tool', () => {
    expect(isReadOnlyTool('gnubok_stage_tool')).toBe(false)
    expect(isReadOnlyTool('gnubok_call_tool')).toBe(false)
    expect(isReadOnlyTool('gnubok_not_a_tool')).toBe(false)
  })

  it('leaves the categorization intent with reads only', () => {
    const tools = getIntent('transaction.categorization')?.tools ?? []
    const kept = tools.filter(isReadOnlyTool)
    expect(kept).toContain('gnubok_query_journal')
    expect(kept).not.toContain('gnubok_categorize_transaction')
  })
})
