import { afterEach, describe, expect, it, vi } from 'vitest'
import { failureCode, matchToPurchase, uploadToInbox } from '../attach-underlag'

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

// PH 225: a file the company already had joins the earlier item; the upload
// says where that one is instead of reporting a new item.
describe('uploadToInbox', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  const pdf = () => new File([new Uint8Array([37, 80, 68, 70])], 'kvitto.pdf', { type: 'application/pdf' })
  const answer = (data: Record<string, unknown>) =>
    vi.fn().mockResolvedValue(new Response(JSON.stringify({ data }), { status: 200 }))

  const refusal = (retryAfter: string) =>
    new Response(JSON.stringify({ error: { code: 'RATE_LIMITED', message: 'För många uppladdningar på kort tid. Försök igen om en stund.' } }), {
      status: 429,
      headers: { 'Retry-After': retryAfter, 'content-type': 'application/json' },
    })
  const stored = () => new Response(JSON.stringify({ data: { inbox_item_id: 'item-new', skip_reason: null } }), { status: 200 })

  // 2026-11-14: a drop in the Inkorg sent every file after the thirtieth
  // straight into the per-minute limit, 118 refused in one minute.
  it('waits out the per-minute upload limit and sends the same file again', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(refusal('60')).mockResolvedValueOnce(stored())
    vi.stubGlobal('fetch', fetchMock)
    const sleep = vi.fn().mockResolvedValue(undefined)
    const onWait = vi.fn()

    expect(await uploadToInbox(pdf(), 'sv', { sleep, onWait })).toEqual({ ok: true, itemId: 'item-new' })
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/extensions/ext/invoice-inbox/upload')).toHaveLength(2)
    expect(sleep).toHaveBeenCalledWith(60_000)
    expect(onWait.mock.calls).toEqual([[60], [null]])
  })

  it('says the upload limit still refuses after waiting, so the caller can stop', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation(async (url: string) => (url === '/api/log' ? new Response('{}') : refusal('60'))))
    const outcome = await uploadToInbox(pdf(), 'sv', { sleep: vi.fn().mockResolvedValue(undefined) })
    expect(outcome).toEqual({ ok: false, reason: 'failed', limited: true, message: 'För många uppladdningar på kort tid. Försök igen om en stund.' })
  })

  it('does not wait for the daily limit, and says it refuses', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => (url === '/api/log' ? new Response('{}') : refusal('3600')))
    vi.stubGlobal('fetch', fetchMock)
    const sleep = vi.fn().mockResolvedValue(undefined)
    const outcome = await uploadToInbox(pdf(), 'sv', { sleep })
    expect(outcome).toMatchObject({ ok: false, reason: 'failed', limited: true })
    expect(sleep).not.toHaveBeenCalled()
    expect(fetchMock.mock.calls.filter(([url]) => url === '/api/extensions/ext/invoice-inbox/upload')).toHaveLength(1)
  })

  it('reports another refusal as a plain failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(async (url: string) =>
        url === '/api/log'
          ? new Response('{}')
          : new Response(JSON.stringify({ error: { code: 'UNSUPPORTED_FILE', message: 'Filtypen stöds inte.' } }), { status: 415 }),
      ),
    )
    const outcome = await uploadToInbox(pdf(), 'sv', { sleep: vi.fn().mockResolvedValue(undefined) })
    expect(outcome).toEqual({ ok: false, reason: 'failed', message: 'Filtypen stöds inte.' })
  })

  it('reports a new item with no duplicate', async () => {
    vi.stubGlobal('fetch', answer({ inbox_item_id: 'item-new', skip_reason: null }))
    expect(await uploadToInbox(pdf(), 'sv')).toEqual({ ok: true, itemId: 'item-new' })
  })

  it('reports a content duplicate with the earlier item state and date', async () => {
    vi.stubGlobal(
      'fetch',
      answer({
        inbox_item_id: 'item-earlier',
        duplicate: true,
        skip_reason: 'duplicate_content',
        duplicate_of: { received_at: '2026-09-30T13:43:20Z', state: 'booked' },
      }),
    )
    expect(await uploadToInbox(pdf(), 'sv')).toEqual({
      ok: true,
      itemId: 'item-earlier',
      duplicateOf: { receivedAt: '2026-09-30T13:43:20Z', state: 'booked' },
    })
  })

  it('treats a state it does not know as still in the inbox', async () => {
    vi.stubGlobal('fetch', answer({ inbox_item_id: 'item-earlier', skip_reason: 'duplicate_content', duplicate_of: { state: 'elsewhere' } }))
    expect(await uploadToInbox(pdf(), 'sv')).toEqual({
      ok: true,
      itemId: 'item-earlier',
      duplicateOf: { receivedAt: null, state: 'inbox' },
    })
  })
})
