/**
 * Guards for Phase 1A: the staged-operation envelope must declare a tight
 * shape for `next` (closed object with required `description`) so agents can
 * dispatch on it programmatically, and `toToolError` must propagate the
 * `retryable` flag from the structured-error registry so agents know which
 * failures are worth retrying.
 *
 * The schema-shape guard walks tools whose outputSchema is the staged
 * envelope and asserts the `next` property matches NEXT_ACTION_HINT_SCHEMA.
 * It doesn't try to test the runtime stagePendingOperation function: that
 * has a transactional supabase dependency exercised by the per-tool tests.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { tools } from '../server'
import { toToolError } from '../tool-result'
import { getStructuredError } from '@/lib/errors/get-structured-error'

function isStagedOperationSchema(schema: unknown): schema is { properties: { next?: Record<string, unknown> } } {
  if (!schema || typeof schema !== 'object') return false
  const s = schema as Record<string, unknown>
  if (s.type !== 'object') return false
  const props = s.properties as Record<string, unknown> | undefined
  return Boolean(props && 'staged' in props && 'risk_level' in props && 'preview' in props)
}

describe('staged operation envelope: next field shape', () => {
  it('every tool returning the staged envelope declares a closed next field', () => {
    const offenders: string[] = []

    for (const tool of tools) {
      if (!isStagedOperationSchema(tool.outputSchema)) continue
      const next = tool.outputSchema.properties.next as Record<string, unknown> | undefined
      if (!next) {
        offenders.push(`${tool.name}: missing next property`)
        continue
      }
      if (next.type !== 'object') {
        offenders.push(`${tool.name}: next.type must be 'object'`)
      }
      if (next.additionalProperties !== false) {
        offenders.push(`${tool.name}: next must have additionalProperties: false`)
      }
      const nextProps = next.properties as Record<string, unknown> | undefined
      if (!nextProps || !nextProps.description) {
        offenders.push(`${tool.name}: next.properties.description missing`)
      }
      const required = next.required as string[] | undefined
      if (!required || !required.includes('description')) {
        offenders.push(`${tool.name}: next.required must include "description"`)
      }
    }

    expect(offenders).toEqual([])
  })
})

describe('staged operation titles: must carry contextual data', () => {
  /**
   * The runtime stagePendingOperation receives a `title` string from each
   * tool's execute(). The approver scans these in the pending-ops list, so
   * generic stubs like "Kategorisering" or "Ny faktura" are useless. We can't
   * easily exercise every tool runtime here (each requires a custom supabase
   * mock), but we CAN guard the source: walk every stagePendingOperation
   * call and require the title literal to either be a template (${...}) or
   * contain enough characters that it must include context.
   */
  it('every stagePendingOperation call uses a template literal title', () => {
    const source = readFileSync(
      resolve(__dirname, '../server.ts'),
      'utf8'
    )

    // Match `stagePendingOperation(...,  <title>,  ...)` where <title> is the
    // 5th argument. We use a forgiving regex: find each call site, then peel
    // the args. The shape is consistent enough across the file (supabase,
    // companyId, userId, opType, title, ...) that the 5th argument is always
    // the title-bearing position.
    const callPattern = /stagePendingOperation\(\s*[^,]+,\s*[^,]+,\s*[^,]+,\s*['"][a-z_]+['"]\s*,\s*(`[^`]+`|'[^']+'|"[^"]+")/g

    const titles: string[] = []
    let match: RegExpExecArray | null
    while ((match = callPattern.exec(source)) !== null) {
      titles.push(match[1])
    }

    // Sanity: we expect at least 20 staging calls in the file. If this drops
    // below that, the regex broke and the rest of the test is meaningless.
    expect(titles.length).toBeGreaterThanOrEqual(20)

    const thin = titles.filter((t) => {
      // Backtick template literals carry ${...} interpolations → contextual.
      // Plain single/double quoted strings without ${} are static labels
      // and must clear a length bar that signals they include detail.
      if (t.startsWith('`') && t.includes('${')) return false
      // Static title: require enough characters that the author must have
      // included at least one piece of context (name, number, period etc.)
      const inner = t.slice(1, -1)
      return inner.length < 25
    })

    expect(thin, `Thin (non-contextual) titles found: ${thin.join(', ')}`).toEqual([])
  })
})

describe('toToolError: retryable propagation', () => {
  it('marks transient bookkeeping DB errors as retryable', () => {
    const err = new Error('Bookkeeping database operation failed')
    // The structured-error registry is what carries the flag; reproduce via
    // the same dispatch path so the contract stays anchored to the registry.
    const structured = getStructuredError(err)
    // Sanity: the inferred code may be UNKNOWN here (no code on the throw).
    // Construct one with an explicit code on the thrown object instead.
    const tagged = Object.assign(new Error('database boom'), { code: 'BOOKKEEPING_DATABASE_ERROR' })
    const result = toToolError(tagged)
    expect(result.error.code).toBe('BOOKKEEPING_DATABASE_ERROR')
    expect(result.error.retryable).toBe(true)
    // Sanity for the prose-only path: don't crash.
    expect(structured.code).toBeTruthy()
  })

  it('marks Riksbanken exchange-rate timeouts as retryable', () => {
    const tagged = Object.assign(new Error('rate fetch timed out'), { code: 'TX_EXCHANGE_RATE_UNAVAILABLE' })
    const result = toToolError(tagged)
    expect(result.error.code).toBe('TX_EXCHANGE_RATE_UNAVAILABLE')
    expect(result.error.retryable).toBe(true)
  })

  it('marks rate-limit responses as retryable', () => {
    const tagged = Object.assign(new Error('over the cap'), { code: 'RATE_LIMITED' })
    const result = toToolError(tagged)
    expect(result.error.code).toBe('RATE_LIMITED')
    expect(result.error.retryable).toBe(true)
  })

  it('marks permanent validation/period errors retryable:false, explicitly, never absent', () => {
    const periodLocked = toToolError(new Error('locked/closed fiscal period'))
    expect(periodLocked.error.code).toBe('PERIOD_LOCKED')
    expect(periodLocked.error.retryable).toBe(false)

    const tagged = Object.assign(new Error('validation'), { code: 'VALIDATION_ERROR' })
    const validation = toToolError(tagged)
    expect(validation.error.retryable).toBe(false)
  })

  it('categorize_transaction accepts idempotency_key so blind retries are replay-safe', () => {
    const tool = tools.find((t) => t.name === 'gnubok_categorize_transaction')!
    const schema = tool.inputSchema as { properties: Record<string, unknown> }
    expect(schema.properties.idempotency_key).toBeDefined()
  })

  it('PERIOD_LOCKED carries a remediation pointing at gnubok_unlock_period', () => {
    const result = toToolError(new Error('locked/closed fiscal period'))
    expect(result.error.code).toBe('PERIOD_LOCKED')
    expect(result.error.remediation?.tool).toBe('gnubok_unlock_period')
  })
})
