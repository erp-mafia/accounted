import { describe, it, expect, vi } from 'vitest'
import { runWithTrace } from '../trace-context-node'
import { traceIdColumn, writeWithTraceId } from '../trace-column'

const TRACE_ID = '4bf92f3577b34da6a3ce929d0e0e4736'

describe('traceIdColumn', () => {
  it('names the column only when there is a trace', () => {
    expect(traceIdColumn(TRACE_ID)).toEqual({ trace_id: TRACE_ID })
    expect(traceIdColumn(null)).toEqual({})
    expect(traceIdColumn(undefined)).toEqual({})
    expect(traceIdColumn('')).toEqual({})
  })
})

describe('writeWithTraceId', () => {
  it('writes once without the column outside a request scope', async () => {
    const write = vi.fn(async (_traceId: string | null) => ({ error: null }))
    await expect(writeWithTraceId(write)).resolves.toEqual({ error: null })
    expect(write.mock.calls).toEqual([[null]])
  })

  it("writes once with the scope's trace when the column is there", async () => {
    const write = vi.fn(async (_traceId: string | null) => ({ error: null }))
    await runWithTrace(TRACE_ID, () => writeWithTraceId(write))
    expect(write.mock.calls).toEqual([[TRACE_ID]])
  })

  it('writes again without the trace while the column is missing (code live before the migration)', async () => {
    for (const code of ['PGRST204', '42703']) {
      const write = vi.fn(async (traceId: string | null) => ({ error: traceId ? { code } : null }))
      await expect(runWithTrace(TRACE_ID, () => writeWithTraceId(write))).resolves.toEqual({ error: null })
      expect(write.mock.calls).toEqual([[TRACE_ID], [null]])
    }
  })

  it('returns any other failure as it is, without a second write', async () => {
    const write = vi.fn(async (_traceId: string | null) => ({ error: { code: '23505' } }))
    await expect(runWithTrace(TRACE_ID, () => writeWithTraceId(write))).resolves.toEqual({ error: { code: '23505' } })
    expect(write).toHaveBeenCalledTimes(1)
  })
})
