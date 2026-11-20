/**
 * callWithBusinessEvents: the two event parameters only with a link, one
 * retry without them only when the database does not know them yet.
 */
import { describe, expect, it, vi } from 'vitest'
import { businessEventRpcParams, callWithBusinessEvents } from '../business-event-rpc'

const LINK = { ids: ['ev-1', null], mode: 'strict' as const }

describe('callWithBusinessEvents', () => {
  it('without a link: one call, nothing added', async () => {
    const call = vi.fn(async () => ({ data: 'ok', error: null }))
    expect(await callWithBusinessEvents('fn', undefined, call)).toEqual({ data: 'ok', error: null })
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith({})
    expect(businessEventRpcParams(undefined)).toEqual({})
  })

  it('with a link: the ids and the mode, in one call', async () => {
    const call = vi.fn(async () => ({ data: 'ok', error: null }))
    await callWithBusinessEvents('fn', LINK, call)
    expect(call).toHaveBeenCalledTimes(1)
    expect(call).toHaveBeenCalledWith({ p_event_ids: ['ev-1', null], p_event_mode: 'strict' })
  })

  it.each(['PGRST202', '42883'])('retries without them once on %s (a database without the migration)', async (code) => {
    const call = vi
      .fn()
      .mockResolvedValueOnce({ data: null, error: { code, message: 'no such function' } })
      .mockResolvedValueOnce({ data: 'ok', error: null })
    expect(await callWithBusinessEvents('fn', LINK, call)).toEqual({ data: 'ok', error: null })
    expect(call).toHaveBeenNthCalledWith(2, {})
  })

  it('any other error is the answer: a strict link the function refused is not retried unlinked', async () => {
    const refused = { data: null, error: { code: '23514', message: 'BUSINESS_EVENT_LINK_REFUSED' } }
    const call = vi.fn(async () => refused)
    expect(await callWithBusinessEvents('fn', LINK, call)).toBe(refused)
    expect(call).toHaveBeenCalledTimes(1)
  })
})
