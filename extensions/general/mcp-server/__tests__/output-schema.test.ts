import { describe, it, expect } from 'vitest'
import { tools } from '../server'

describe('outputSchema coverage', () => {
  it('every tool declares an outputSchema', () => {
    const missing = tools.filter((t) => !t.outputSchema).map((t) => t.name)
    expect(missing).toEqual([])
  })

  it('every outputSchema is an object schema', () => {
    for (const t of tools) {
      expect(t.outputSchema, `tool ${t.name} outputSchema`).toBeDefined()
      const schema = t.outputSchema as Record<string, unknown>
      expect(schema.type, `tool ${t.name} outputSchema.type`).toBe('object')
    }
  })

  it('every tool has a tight description (<= 280 chars)', () => {
    const tooLong = tools.filter((t) => t.description.length > 280)
    expect(tooLong.map((t) => `${t.name}: ${t.description.length} chars`)).toEqual([])
  })

  it('no description embeds Args:/Returns:/Examples: blocks (those belong to JSON Schema)', () => {
    const verbose = tools.filter((t) =>
      /Args:\s*\n|Returns JSON:|Examples:\s*\n|Errors:\s*\n/.test(t.description)
    )
    expect(verbose.map((t) => t.name)).toEqual([])
  })
})

describe('annotation correctness', () => {
  it('gnubok_feedback is not read-only (it writes a telemetry event + mutates the rate-limit map)', () => {
    const feedback = tools.find((t) => t.name === 'gnubok_feedback')
    expect(feedback).toBeDefined()
    expect(feedback?.annotations?.readOnlyHint).toBe(false)
  })
})
