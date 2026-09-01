import { describe, expect, it } from 'vitest'
import { tools, isDefaultCatalogTool } from '../server'
import { findUnknownArgKeys, shortestExampleFor } from '../arg-guard'

/**
 * Worked `examples` on the tool inputSchema (#2066).
 *
 * An example is a call an agent will copy. If our own boundary would reject
 * it, the example is worse than none: it teaches the exact mistake the guard
 * then punishes. So every example is checked against the schema it ships with,
 * with the same unknown-key rule the server enforces at runtime.
 */

interface JsonSchema {
  type?: string
  properties?: Record<string, JsonSchema>
  required?: string[]
  enum?: unknown[]
  items?: JsonSchema
  additionalProperties?: unknown
  pattern?: string
  examples?: unknown[]
}

const withExamples = tools
  .map((t) => ({ name: t.name, schema: t.inputSchema as JsonSchema }))
  .filter((t) => Array.isArray(t.schema.examples))

/** Placeholder ids are deliberately short ("3f1a..."): they must not read as real UUIDs. */
const PLACEHOLDER = /^[0-9a-f]{4}\.\.\.$/

function typeOf(value: unknown): string {
  if (Array.isArray(value)) return 'array'
  if (value === null) return 'null'
  return typeof value
}

function checkValue(path: string, value: unknown, schema: JsonSchema, problems: string[]): void {
  if (schema.type && schema.type !== typeOf(value)) {
    // A placeholder id stands in for a UUID string; still a string.
    problems.push(`${path}: expected ${schema.type}, got ${typeOf(value)}`)
    return
  }
  if (schema.enum && !schema.enum.includes(value)) {
    problems.push(`${path}: ${JSON.stringify(value)} is not in the declared enum`)
  }
  if (schema.pattern && typeof value === 'string' && !new RegExp(schema.pattern).test(value)) {
    problems.push(`${path}: ${JSON.stringify(value)} does not match ${schema.pattern}`)
  }
  if (schema.type === 'array' && Array.isArray(value) && schema.items) {
    value.forEach((item, i) => checkValue(`${path}[${i}]`, item, schema.items!, problems))
  }
  if (schema.type === 'object' && schema.properties && value && typeof value === 'object') {
    checkObject(path, value as Record<string, unknown>, schema, problems)
  }
}

function checkObject(path: string, value: Record<string, unknown>, schema: JsonSchema, problems: string[]): void {
  for (const req of schema.required ?? []) {
    if (!(req in value)) problems.push(`${path}: missing required property "${req}"`)
  }
  for (const [key, val] of Object.entries(value)) {
    const propSchema = schema.properties?.[key]
    if (!propSchema) continue
    checkValue(`${path}.${key}`, val, propSchema, problems)
  }
}

describe('inputSchema examples are calls the server would accept', () => {
  it('ships examples on at least the tools this change targeted', () => {
    // Pinned so a rename or a schema rewrite cannot silently drop them.
    expect(withExamples.map((t) => t.name).sort()).toEqual([
      'gnubok_approve_pending_operation',
      'gnubok_categorize_transaction',
      'gnubok_create_voucher',
      'gnubok_get_kpi_report',
      'gnubok_query_journal',
    ])
  })

  it('every example survives the unknown-parameter guard that rejects real calls', () => {
    const offenders: string[] = []
    for (const { name, schema } of withExamples) {
      for (const [i, example] of (schema.examples ?? []).entries()) {
        const unknown = findUnknownArgKeys(schema as Record<string, unknown>, example as Record<string, unknown>)
        if (unknown.length > 0) offenders.push(`${name}[${i}]: ${unknown.join(', ')}`)
      }
    }
    expect(offenders).toEqual([])
  })

  it('every example satisfies required properties, declared types, enums and patterns', () => {
    const problems: string[] = []
    for (const { name, schema } of withExamples) {
      for (const [i, example] of (schema.examples ?? []).entries()) {
        checkObject(`${name}[${i}]`, example as Record<string, unknown>, schema, problems)
      }
    }
    expect(problems).toEqual([])
  })

  it('examples live only on tools the default catalog actually publishes', () => {
    // An example on a search-only tool is budget spent where no agent reads it.
    const hidden = withExamples.filter(({ name }) => {
      const tool = tools.find((t) => t.name === name)!
      return !isDefaultCatalogTool(tool)
    })
    expect(hidden.map((t) => t.name)).toEqual([])
  })

  it('uses obvious placeholders for ids, never invented UUIDs', () => {
    // A real-looking UUID in an example gets copied verbatim and 404s; worse,
    // it could name a row in some other tenant.
    const suspicious: string[] = []
    const walk = (label: string, value: unknown) => {
      if (typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}/.test(value)) suspicious.push(`${label}=${value}`)
      else if (Array.isArray(value)) value.forEach((v, i) => walk(`${label}[${i}]`, v))
      else if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) walk(`${label}.${k}`, v)
      }
    }
    for (const { name, schema } of withExamples) {
      for (const [i, example] of (schema.examples ?? []).entries()) walk(`${name}[${i}]`, example)
    }
    expect(suspicious).toEqual([])
    // And the placeholders we do use are recognisable as placeholders.
    const ids = (withExamples.find((t) => t.name === 'gnubok_categorize_transaction')!.schema.examples ?? [])
      .map((e) => (e as Record<string, string>).transaction_id)
    expect(ids.every((id) => PLACEHOLDER.test(id))).toBe(true)
  })
})

describe('shortestExampleFor: examples reach the caller that already failed', () => {
  it('picks the shortest example, so the error stays readable', () => {
    const schema = {
      examples: [{ a: 1, b: 2, c: 3, d: 4 }, { a: 1 }],
    } as Record<string, unknown>
    expect(shortestExampleFor(schema)).toBe('{"a":1}')
  })

  it('returns nothing when the tool publishes no examples', () => {
    expect(shortestExampleFor({})).toBe('')
    expect(shortestExampleFor({ examples: [] })).toBe('')
  })

  it('declines an example too long to help inside an error message', () => {
    const long = { note: 'x'.repeat(400) }
    expect(shortestExampleFor({ examples: [long] })).toBe('')
  })

  it('gives the kpi-report caller the empty-object shape it needed', () => {
    // The exact prod case: `metric` sent to a tool whose only parameter is
    // period_id, 604 times over seven days.
    const kpi = tools.find((t) => t.name === 'gnubok_get_kpi_report')!
    expect(shortestExampleFor(kpi.inputSchema as Record<string, unknown>)).toBe('{}')
  })
})
