import { afterEach, describe, expect, it, vi } from 'vitest'
import { failureCode, matchToPurchase } from '../attach-underlag'

// crm#1479: the drop on a purchase asks the server to compare the document
// with the purchase, and "attach anyway" is the person's stated reason.
describe('matchToPurchase', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('asks for the comparison on the drop, and confirms only when the person said so', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    await matchToPurchase('item-1', 'tx-1')
    await matchToPurchase('item-1', 'tx-1', true)

    expect(fetchMock.mock.calls[0][0]).toBe('/api/extensions/ext/invoice-inbox/items/item-1/match-transaction')
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ transaction_id: 'tx-1', check_fit: true })
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({
      transaction_id: 'tx-1',
      check_fit: true,
      mismatch_reason: 'confirmed_in_app',
    })
  })
})

describe('failureCode', () => {
  it('reads the refusal code and leaves the body readable for the message', async () => {
    const res = new Response(JSON.stringify({ error: { code: 'DOC_ROW_MISMATCH', message: 'Underlaget verkar höra till ett annat köp' } }), {
      status: 409,
    })
    expect(await failureCode(res)).toBe('DOC_ROW_MISMATCH')
    expect(((await res.json()) as { error: { message: string } }).error.message).toContain('annat köp')
  })

  it('answers null for a body that is not an error envelope', async () => {
    expect(await failureCode(new Response('not json', { status: 500 }))).toBeNull()
  })
})
