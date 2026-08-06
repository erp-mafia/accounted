import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { listOrderRefunds, type WooCredentials } from '../lib/api-client'

const CREDS: WooCredentials = {
  storeUrl: 'https://shop.example.se',
  consumerKey: 'ck_test',
  consumerSecret: 'cs_test',
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}

function makeRefunds(startId: number, count: number) {
  return Array.from({ length: count }, (_, i) => ({
    id: startId + i,
    amount: '10.00',
    reason: '',
    date_created_gmt: '2026-08-01T10:00:00',
  }))
}

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('listOrderRefunds', () => {
  it('terminates on an empty page, not a short one (hosts may cap per_page)', async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse(makeRefunds(1, 50))) // short but non-empty
      .mockResolvedValueOnce(jsonResponse(makeRefunds(51, 50)))
      .mockResolvedValueOnce(jsonResponse([]))

    const refunds = await listOrderRefunds(CREDS, 42)
    expect(refunds).toHaveLength(100)
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('stops when a host ignoring `page` repeats the same rows', async () => {
    // Fresh Response per call: a Response body is single-use.
    fetchMock.mockImplementation(async () => jsonResponse(makeRefunds(1, 100)))

    const refunds = await listOrderRefunds(CREDS, 42)
    expect(refunds).toHaveLength(100)
    // Page 1 full of fresh rows, page 2 identical → zero fresh → stop.
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('throws instead of returning a silently partial list when the page cap is exhausted', async () => {
    // Ten full pages of genuinely fresh rows: the cap trips with data still
    // flowing, and a partial return would let the sync cursor pass unseen
    // refunds. The thrown error routes into the caller's held-cursor retry.
    fetchMock.mockImplementation(async (url: string | URL) => {
      const page = Number(new URL(String(url)).searchParams.get('page'))
      return jsonResponse(makeRefunds(page * 1000, 100))
    })

    await expect(listOrderRefunds(CREDS, 42)).rejects.toThrow(
      /Refund pagination cap exceeded/,
    )
    expect(fetchMock).toHaveBeenCalledTimes(10)
  })
})
