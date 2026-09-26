/**
 * Read-only report tools accept the parameter synonyms agents actually send
 * (prod telemetry: fiscal_period_id, date_from/date_to, start_date/end_date,
 * as_of_date, account_number, metric), mapped onto the tool's own names.
 * tools/list stays strict: no alias ever appears in a published schema.
 */
import { describe, it, expect } from 'vitest'
import {
  REPORT_ARG_ALIASES,
  normalizeReportArgAliases,
  suggestArgKey,
} from '../report-arg-aliases'
import { tools } from '../server'

describe('normalizeReportArgAliases', () => {
  it('renames a known alias to the canonical parameter', () => {
    const { args, applied, conflicts } = normalizeReportArgAliases('gnubok_get_income_statement', {
      fiscal_period_id: 'fp-1',
      date_from: '2026-01-01',
    })
    expect(args).toEqual({ period_id: 'fp-1', from_date: '2026-01-01' })
    expect(applied.map((a) => a.alias).sort()).toEqual(['date_from', 'fiscal_period_id'])
    expect(conflicts).toEqual([])
  })

  it('wraps a scalar metric into the metrics array', () => {
    const { args } = normalizeReportArgAliases('gnubok_get_kpi_report', { metric: 'cash_position' })
    expect(args).toEqual({ metrics: ['cash_position'] })
  })

  it('fans a single account_number out to both general-ledger bounds', () => {
    const { args } = normalizeReportArgAliases('gnubok_get_general_ledger', { account_number: '1930' })
    expect(args).toEqual({ account_from: '1930', account_to: '1930' })
  })

  it('maps the query_journal free-text synonyms to text', () => {
    const { args } = normalizeReportArgAliases('gnubok_query_journal', { query: 'hyra', start_date: '2026-01-01' })
    expect(args).toEqual({ text: 'hyra', date_from: '2026-01-01' })
  })

  it('refuses an alias that collides with its canonical key instead of picking a side', () => {
    const { args, conflicts } = normalizeReportArgAliases('gnubok_get_kpi_report', {
      metric: 'cash_position',
      metrics: ['net_result'],
    })
    expect(conflicts).toEqual([{ alias: 'metric', canonical: 'metrics' }])
    expect(args.metrics).toEqual(['net_result'])
  })

  it('refuses two aliases that land on the same canonical key', () => {
    const { conflicts } = normalizeReportArgAliases('gnubok_get_balance_sheet', {
      to_date: '2026-06-30',
      end_date: '2026-07-31',
    })
    expect(conflicts).toHaveLength(1)
    expect(conflicts[0].canonical).toBe('as_of_date')
  })

  it('leaves tools without an alias table untouched', () => {
    const input = { fiscal_period_id: 'fp-1' }
    const { args, applied } = normalizeReportArgAliases('gnubok_close_period', input)
    expect(args).toBe(input)
    expect(applied).toEqual([])
  })

  it('only targets read-only tools, and every mapping lands on a published parameter', () => {
    for (const [toolName, table] of Object.entries(REPORT_ARG_ALIASES)) {
      const tool = tools.find((t) => t.name === toolName)
      expect(tool, toolName).toBeDefined()
      expect(tool!.annotations?.readOnlyHint, toolName).toBe(true)
      const published = Object.keys((tool!.inputSchema as { properties: Record<string, unknown> }).properties)
      for (const [alias, rule] of Object.entries(table)) {
        expect(published, `${toolName}: alias ${alias} must not be published`).not.toContain(alias)
        for (const target of rule.to) {
          expect(published, `${toolName}: ${alias} -> ${target}`).toContain(target)
        }
      }
    }
  })
})

describe('suggestArgKey', () => {
  it('names the parameter an unknown synonym most likely meant', () => {
    expect(suggestArgKey('fiscal_period_id', ['period_id', 'account'])).toBe('period_id')
    expect(suggestArgKey('date_from', ['from_date', 'to_date'])).toBe('from_date')
    expect(suggestArgKey('search', ['query', 'limit'])).toBe('query')
  })

  it('returns null when nothing close is valid', () => {
    expect(suggestArgKey('fiscal_period_id', ['invoice_id'])).toBeNull()
    expect(suggestArgKey('fromdate', ['from_date'])).toBeNull()
  })
})
