import { describe, it, expect } from 'vitest'
import { runRequestInTrace, runWithTrace } from '../trace-context-node'
import {
  TRACE_ID_HEADER,
  getTraceId,
  newTraceId,
  parseTraceparent,
  stampTraceIdHeader,
  traceIdFromRequest,
} from '../trace-context'

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736'
const PARENT_ID = '00f067aa0ba902b7'
const VALID = `00-${TRACE_ID}-${PARENT_ID}-01`

describe('parseTraceparent', () => {
  it('returns the trace-id of a valid version-00 header', () => {
    expect(parseTraceparent(VALID)).toBe(TRACE_ID)
    expect(parseTraceparent(`00-${TRACE_ID}-${PARENT_ID}-00`)).toBe(TRACE_ID)
  })

  it('returns null for a missing value', () => {
    expect(parseTraceparent(null)).toBeNull()
    expect(parseTraceparent(undefined)).toBeNull()
    expect(parseTraceparent('')).toBeNull()
  })

  it('refuses an all-zero trace-id or parent-id', () => {
    expect(parseTraceparent(`00-${'0'.repeat(32)}-${PARENT_ID}-01`)).toBeNull()
    expect(parseTraceparent(`00-${TRACE_ID}-${'0'.repeat(16)}-01`)).toBeNull()
  })

  it('refuses any version but 00', () => {
    expect(parseTraceparent(`01-${TRACE_ID}-${PARENT_ID}-01`)).toBeNull()
    expect(parseTraceparent(`ff-${TRACE_ID}-${PARENT_ID}-01`)).toBeNull()
    // A future version may append fields; version 00 has exactly four.
    expect(parseTraceparent(`${VALID}-extra`)).toBeNull()
  })

  it('refuses wrong field lengths', () => {
    expect(parseTraceparent(`00-${TRACE_ID.slice(1)}-${PARENT_ID}-01`)).toBeNull()
    expect(parseTraceparent(`00-${TRACE_ID}0-${PARENT_ID}-01`)).toBeNull()
    expect(parseTraceparent(`00-${TRACE_ID}-${PARENT_ID.slice(1)}-01`)).toBeNull()
    expect(parseTraceparent(`00-${TRACE_ID}-${PARENT_ID}-1`)).toBeNull()
    expect(parseTraceparent(`0-${TRACE_ID}-${PARENT_ID}-01`)).toBeNull()
  })

  it('refuses uppercase and non-hex characters (the spec requires lowercase hex)', () => {
    expect(parseTraceparent(VALID.toUpperCase())).toBeNull()
    expect(parseTraceparent(`00-${TRACE_ID.toUpperCase()}-${PARENT_ID}-01`)).toBeNull()
    expect(parseTraceparent(`00-${TRACE_ID.slice(0, 31)}g-${PARENT_ID}-01`)).toBeNull()
    expect(parseTraceparent(` ${VALID}`)).toBeNull()
  })
})

describe('newTraceId', () => {
  it('mints 32 lowercase hex characters, not all zeros, different each time', () => {
    const a = newTraceId()
    const b = newTraceId()
    expect(a).toMatch(/^[0-9a-f]{32}$/)
    expect(a).not.toMatch(/^0+$/)
    expect(a).not.toBe(b)
    // A minted id is itself a valid trace-id.
    expect(parseTraceparent(`00-${a}-${PARENT_ID}-01`)).toBe(a)
  })
})

describe('traceIdFromRequest', () => {
  it('takes the trace of a valid traceparent header', () => {
    const request = new Request('https://app.example/api/x', { headers: { traceparent: VALID } })
    expect(traceIdFromRequest(request)).toBe(TRACE_ID)
  })

  it('mints one when the header is missing or invalid', () => {
    const missing = traceIdFromRequest(new Request('https://app.example/api/x'))
    const invalid = traceIdFromRequest(
      new Request('https://app.example/api/x', { headers: { traceparent: VALID.toUpperCase() } }),
    )
    expect(missing).toMatch(/^[0-9a-f]{32}$/)
    expect(invalid).toMatch(/^[0-9a-f]{32}$/)
    expect(invalid).not.toBe(TRACE_ID)
  })
})

describe('trace scope (AsyncLocalStorage)', () => {
  it('returns undefined outside a runWithTrace scope', () => {
    expect(getTraceId()).toBeUndefined()
  })

  it('exposes the trace inside the scope, across awaits, and not after it', async () => {
    const seen: Array<string | undefined> = []
    await runWithTrace(TRACE_ID, async () => {
      seen.push(getTraceId())
      await new Promise((resolve) => setTimeout(resolve, 0))
      seen.push(getTraceId())
    })
    expect(seen).toEqual([TRACE_ID, TRACE_ID])
    expect(getTraceId()).toBeUndefined()
  })

  it('keeps concurrent scopes isolated', async () => {
    const other = newTraceId()
    const results = await Promise.all([
      runWithTrace(TRACE_ID, async () => {
        await new Promise((resolve) => setTimeout(resolve, 5))
        return getTraceId()
      }),
      runWithTrace(other, async () => getTraceId()),
    ])
    expect(results).toEqual([TRACE_ID, other])
  })

  it('lets a nested scope override the outer one and restores it afterwards', async () => {
    const inner = newTraceId()
    const seen = await runWithTrace(TRACE_ID, async () => {
      const nested = await runWithTrace(inner, async () => {
        await Promise.resolve()
        return getTraceId()
      })
      return { nested, after: getTraceId() }
    })
    expect(seen).toEqual({ nested: inner, after: TRACE_ID })
  })

  it('propagates into nested calls without parameter threading', async () => {
    const deepRead = async () => getTraceId()
    const middle = async () => deepRead()
    expect(await runWithTrace(TRACE_ID, middle)).toBe(TRACE_ID)
  })
})

describe('X-Trace-Id', () => {
  it('runRequestInTrace runs the handling in the scope and names the trace on the response', async () => {
    let inside: string | undefined
    const response = await runRequestInTrace(TRACE_ID, async () => {
      inside = getTraceId()
      return new Response('ok')
    })
    expect(inside).toBe(TRACE_ID)
    expect(response.headers.get(TRACE_ID_HEADER)).toBe(TRACE_ID)
  })

  it('keeps the trace a nested door already named', async () => {
    const inner = newTraceId()
    const response = await runRequestInTrace(TRACE_ID, () =>
      runRequestInTrace(inner, async () => new Response('ok')),
    )
    expect(response.headers.get(TRACE_ID_HEADER)).toBe(inner)
  })

  it('leaves a response with immutable headers as it is', () => {
    const redirect = Response.redirect('https://app.example/elsewhere', 302)
    expect(() => stampTraceIdHeader(redirect, TRACE_ID)).not.toThrow()
  })
})
