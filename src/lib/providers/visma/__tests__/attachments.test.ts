/**
 * A Visma customer invoice's own PDF: the link Visma answers with is
 * followed only into its own storage, over https and without our token.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { VismaClient } from '../client'
import { fetchVismaInvoicePdf, VismaFileDownloadError, vismaTemporaryFileUrl } from '../attachments'

const STORAGE = 'https://eaccountingstoragese.vismaonline.com/temp/fileanonymous/0b6f5a3e'

function clientAnswering(answer: unknown) {
  const get = vi.fn().mockResolvedValue(answer)
  return { client: { get } as unknown as VismaClient, get }
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('vismaTemporaryFileUrl', () => {
  it('reads TemporaryUrl, and Url as Visma\'s older answers name it', () => {
    expect(vismaTemporaryFileUrl({ TemporaryUrl: STORAGE })?.toString()).toBe(STORAGE)
    expect(vismaTemporaryFileUrl({ Url: STORAGE })?.toString()).toBe(STORAGE)
    expect(vismaTemporaryFileUrl({ TemporaryUrl: '', Url: STORAGE })?.toString()).toBe(STORAGE)
  })

  it.each([
    ['plain http', 'http://eaccountingstoragese.vismaonline.com/temp/x'],
    ['another host', 'https://files.example.com/temp/x'],
    ['a host that only starts like Visma\'s', 'https://vismaonline.com.example.com/temp/x'],
    ['a host that only ends like it', 'https://evilvismaonline.com/temp/x'],
    ['credentials in the link', 'https://user:pass@eaccountingstoragese.vismaonline.com/temp/x'],
    ['no link', ''],
    ['not a link', 'temp/fileanonymous/x'],
  ])('names no link for %s', (_label, raw) => {
    expect(vismaTemporaryFileUrl({ TemporaryUrl: raw })).toBeNull()
  })

  it('names no link for an answer without one', () => {
    expect(vismaTemporaryFileUrl(null)).toBeNull()
    expect(vismaTemporaryFileUrl('https://eaccountingstoragese.vismaonline.com/x')).toBeNull()
    expect(vismaTemporaryFileUrl({ Id: 'x' })).toBeNull()
  })
})

describe('fetchVismaInvoicePdf', () => {
  it('asks Visma for the invoice\'s link, then reads it without our token and without following a redirect', async () => {
    const { client, get } = clientAnswering({ TemporaryUrl: STORAGE })
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([0x25, 0x50, 0x44, 0x46]), { status: 200, headers: { 'content-type': 'application/pdf' } }),
    )
    vi.stubGlobal('fetch', fetchMock)

    const file = await fetchVismaInvoicePdf(client, 'visma-token', 'a1b2/c3')

    expect(get).toHaveBeenCalledWith('visma-token', '/customerinvoices/a1b2%2Fc3/pdf')
    expect(new Uint8Array(file.bytes)).toEqual(new Uint8Array([0x25, 0x50, 0x44, 0x46]))
    expect(file.contentType).toBe('application/pdf')
    const [url, init] = fetchMock.mock.calls[0]
    expect(String(url)).toBe(STORAGE)
    expect(init).toMatchObject({ redirect: 'error' })
    expect(init?.headers).toBeUndefined()
  })

  it('reads nothing when the answer names no link into Visma\'s storage', async () => {
    const { client } = clientAnswering({ TemporaryUrl: 'https://files.example.com/x' })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(fetchVismaInvoicePdf(client, 'visma-token', 'inv')).rejects.toMatchObject({
      name: 'VismaFileDownloadError',
      message: 'VISMA_INVOICE_PDF_LINK_MISSING',
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('fails the one invoice when the link is gone, without asking again', async () => {
    const { client } = clientAnswering({ TemporaryUrl: STORAGE })
    const fetchMock = vi.fn().mockResolvedValue(new Response('gone', { status: 404 }))
    vi.stubGlobal('fetch', fetchMock)

    const error = await fetchVismaInvoicePdf(client, 'visma-token', 'inv').catch((e) => e)

    expect(error).toBeInstanceOf(VismaFileDownloadError)
    expect(error).toMatchObject({ statusCode: 404 })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('refuses a body far larger than an invoice PDF', async () => {
    const { client } = clientAnswering({ TemporaryUrl: STORAGE })
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('x', { status: 200, headers: { 'content-length': String(50 * 1024 * 1024) } })),
    )

    await expect(fetchVismaInvoicePdf(client, 'visma-token', 'inv')).rejects.toMatchObject({
      message: 'VISMA_INVOICE_PDF_TOO_LARGE',
    })
  })
})
