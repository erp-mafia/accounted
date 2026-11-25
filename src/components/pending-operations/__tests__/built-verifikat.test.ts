/**
 * The card beside Godkänn asks the server for the rows a proposal's approval
 * builds at the click: the proposal's own route, never answered from a
 * cache, and only an answer of the route's shape is shown.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { askBuiltVerifikat } from '../built-verifikat'

const fetchMock = vi.fn()
const answered = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status }))

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('askBuiltVerifikat', () => {
  it('asks the proposal\'s own route, never from a cache, and answers what it says', async () => {
    fetchMock.mockImplementation(() => answered({ data: { posts: 'nothing' } }))
    await expect(askBuiltVerifikat('op-1')).resolves.toEqual({ posts: 'nothing' })
    expect(fetchMock).toHaveBeenCalledWith('/api/pending-operations/op-1/verifikat', { cache: 'no-store' })
    fetchMock.mockImplementation(() => answered({ data: { posts: 'at_approval' } }))
    await expect(askBuiltVerifikat('op-1')).resolves.toEqual({ posts: 'at_approval' })
  })

  it('a refusal by the route, or an answer of another shape, is a failure the card says', async () => {
    fetchMock.mockImplementationOnce(() => answered({ error: { code: 'PENDING_OPERATION_NOT_FOUND' } }, 404))
    await expect(askBuiltVerifikat('op-1')).rejects.toThrow('HTTP 404')
    fetchMock.mockImplementationOnce(() => answered({ data: { lines: [] } }))
    await expect(askBuiltVerifikat('op-1')).rejects.toThrow('unexpected answer')
  })
})
