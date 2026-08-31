import { describe, it, expect } from 'vitest'
import {
  extractRecord,
  parseArgs,
  percentile,
  renderMarkdown,
  summarize,
} from '../perf/log-percentiles'

const opLine = (operation: string, durationMs: number, authMs = 2) =>
  JSON.stringify({
    level: 'info',
    module: `api/${operation}`,
    msg: 'op completed',
    operation,
    durationMs,
    authMs,
  })

describe('extractRecord', () => {
  it('parses a bare logger line', () => {
    expect(extractRecord(opLine('period.list', 77))).toMatchObject({
      operation: 'period.list',
      durationMs: 77,
    })
  })

  it('unwraps the JSON embedded in a vercel logs --json envelope', () => {
    const envelope = JSON.stringify({
      timestamp: 1,
      source: 'serverless',
      requestPath: '/api/bookkeeping/fiscal-periods',
      message: `    ${opLine('period.list', 77)}`,
    })
    expect(extractRecord(envelope)).toMatchObject({
      source: 'serverless',
      operation: 'period.list',
      durationMs: 77,
    })
  })

  it('keeps a non-JSON message as the envelope only', () => {
    expect(extractRecord(JSON.stringify({ message: 'plain text' }))).toEqual({
      message: 'plain text',
    })
  })

  it('ignores blank and unparseable lines', () => {
    expect(extractRecord('')).toBeNull()
    expect(extractRecord('not json')).toBeNull()
    expect(extractRecord('{broken')).toBeNull()
  })
})

describe('percentile', () => {
  it('uses nearest rank', () => {
    const sorted = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]
    expect(percentile(sorted, 50)).toBe(5)
    expect(percentile(sorted, 90)).toBe(9)
    expect(percentile(sorted, 99)).toBe(10)
    expect(percentile([42], 50)).toBe(42)
    expect(Number.isNaN(percentile([], 50))).toBe(true)
  })
})

describe('summarize', () => {
  const records = [
    { operation: 'a', durationMs: 10, authMs: 1 },
    { operation: 'a', durationMs: 30, authMs: 1 },
    { operation: 'b', durationMs: 100, authMs: 50 },
    { operation: 'b', durationMs: 'oops', authMs: 5 },
  ]

  it('groups by the requested keys and ranks slowest first', () => {
    const rows = summarize(records, { fields: ['durationMs', 'authMs'], groupBy: ['operation'] })
    expect(rows.map((r) => r.group)).toEqual(['b', 'a'])
    expect(rows[1].count).toBe(2)
    expect(rows[1].fields.durationMs).toEqual({ p50: 10, p90: 30, p99: 30, max: 30 })
    // The non-numeric durationMs is skipped for that field but the row still counts the sample.
    expect(rows[0].count).toBe(2)
    expect(rows[0].fields.durationMs.max).toBe(100)
  })

  it('applies exact-match filters and min-count', () => {
    const rows = summarize(records, {
      fields: ['durationMs'],
      groupBy: ['operation'],
      filters: [{ key: 'operation', value: 'a' }],
    })
    expect(rows).toHaveLength(1)
    expect(rows[0].group).toBe('a')
    expect(summarize(records, { fields: ['durationMs'], groupBy: ['operation'], minCount: 3 })).toEqual([])
  })

  it('produces a single "all" row without grouping', () => {
    const rows = summarize(records, { fields: ['durationMs'] })
    expect(rows).toHaveLength(1)
    expect(rows[0].group).toBe('all')
    expect(rows[0].count).toBe(4)
  })
})

describe('renderMarkdown + parseArgs', () => {
  it('renders a markdown table with one column set per field', () => {
    const rows = summarize([{ k: 'x', v: 5 }], { fields: ['v'], groupBy: ['k'] })
    const md = renderMarkdown(rows, ['v'])
    expect(md.split('\n')[0]).toBe('| group | n | v p50 | v p90 | v p99 | v max |')
    expect(md).toContain('| x | 1 | 5 | 5 | 5 | 5 |')
  })

  it('parses the documented CLI flags', () => {
    expect(
      parseArgs(['--field', 'a,b', '--group', 'kind,route', '--filter', 'msg=op completed', '--min-count', '5']),
    ).toEqual({
      fields: ['a', 'b'],
      groupBy: ['kind', 'route'],
      filters: [{ key: 'msg', value: 'op completed' }],
      minCount: 5,
    })
    expect(() => parseArgs([])).toThrow('--field is required')
    expect(() => parseArgs(['--bogus'])).toThrow('unknown option')
  })
})
