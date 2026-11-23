/**
 * The verifikat side panel: which click opens it, and what its two reads
 * answer. A plain click reads the verifikat in place; every other click
 * stays the browser's, so the link keeps opening a tab or a window.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  opensPeek,
  readVoucherPeek,
  readVoucherPeekUnderlag,
  voucherPageHref,
  type PeekClick,
} from '../voucher-peek'

const plainClick: PeekClick = {
  button: 0,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  defaultPrevented: false,
}

describe('opensPeek', () => {
  it('opens the panel on an unmodified primary-button click', () => {
    expect(opensPeek(plainClick)).toBe(true)
  })

  it.each(['metaKey', 'ctrlKey', 'shiftKey', 'altKey'] as const)('leaves a click with %s to the browser', (modifier) => {
    expect(opensPeek({ ...plainClick, [modifier]: true })).toBe(false)
  })

  it('leaves the middle and the secondary button to the browser', () => {
    expect(opensPeek({ ...plainClick, button: 1 })).toBe(false)
    expect(opensPeek({ ...plainClick, button: 2 })).toBe(false)
  })

  it('leaves a click something else already handled alone', () => {
    expect(opensPeek({ ...plainClick, defaultPrevented: true })).toBe(false)
  })
})

describe('voucherPageHref', () => {
  it('is the verifikat page of the entry', () => {
    expect(voucherPageHref('entry-1')).toBe('/bookkeeping/entry-1')
  })
})

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** Answers each request by the first route whose fragment the URL contains; an unlisted URL fails the test. */
function api(routes: Record<string, () => Response>) {
  return vi.fn(async (url: string) => {
    const match = Object.keys(routes).find((fragment) => url.includes(fragment))
    if (!match) throw new Error(`unexpected request: ${url}`)
    return routes[match]()
  })
}

const entry = {
  id: 'entry-1',
  voucher_series: 'A',
  voucher_number: 12,
  entry_date: '2026-03-14',
  description: 'Test entry',
  status: 'posted',
  source_type: 'manual',
  lines: [
    { id: 'line-1', account_number: '1930', debit_amount: 0, credit_amount: 125, sort_order: 1 },
    { id: 'line-2', account_number: '6110', debit_amount: 125, credit_amount: 0, sort_order: 0 },
  ],
}

describe('readVoucherPeek', () => {
  it('answers the verifikat with its lines, uncorrected when it has no rättelse', async () => {
    const request = api({
      'rattelse-flags': () => json({ data: [] }),
      'journal-entries/entry-1': () => json({ data: entry }),
    })
    const read = await readVoucherPeek('entry-1', request)
    expect(read).toEqual({ state: 'ready', entry, corrected: false })
    expect(request.mock.calls.map(([url]) => url)).toContain('/api/bookkeeping/journal-entries/entry-1')
  })

  it('marks a verifikat with an inline rättelse as corrected', async () => {
    const request = api({
      'rattelse-flags': () => json({ data: ['entry-1'] }),
      'journal-entries/entry-1': () => json({ data: entry }),
    })
    expect(await readVoucherPeek('entry-1', request)).toMatchObject({ state: 'ready', corrected: true })
  })

  it('answers missing for a verifikat that does not exist', async () => {
    const request = api({
      'rattelse-flags': () => json({ data: [] }),
      'journal-entries/entry-1': () => json({ error: 'not found' }, 404),
    })
    expect(await readVoucherPeek('entry-1', request)).toEqual({ state: 'missing' })
  })

  it('fails when the read fails', async () => {
    const request = api({
      'rattelse-flags': () => json({ data: [] }),
      'journal-entries/entry-1': () => json({ error: 'down' }, 500),
    })
    expect(await readVoucherPeek('entry-1', request)).toEqual({ state: 'failed' })
  })

  it('fails rather than show a possibly corrected verifikat as untouched', async () => {
    const request = api({
      'rattelse-flags': () => json({ error: 'down' }, 500),
      'journal-entries/entry-1': () => json({ data: entry }),
    })
    expect(await readVoucherPeek('entry-1', request)).toEqual({ state: 'failed' })
  })

  it('fails on an answer that is not a verifikat', async () => {
    const request = api({
      'rattelse-flags': () => json({ data: [] }),
      'journal-entries/entry-1': () => json({ data: { id: 'entry-1' } }),
    })
    expect(await readVoucherPeek('entry-1', request)).toEqual({ state: 'failed' })
  })

  it('fails when the request never answers', async () => {
    const request = vi.fn(async (): Promise<Response> => {
      throw new Error('offline')
    })
    expect(await readVoucherPeek('entry-1', request)).toEqual({ state: 'failed' })
  })

  it('keeps an id with path characters inside its own path segment', async () => {
    const request = api({
      'rattelse-flags': () => json({ data: [] }),
      'journal-entries/': () => json({ error: 'not found' }, 404),
    })
    await readVoucherPeek('../settings', request)
    expect(request.mock.calls.map(([url]) => url)).toContain('/api/bookkeeping/journal-entries/..%2Fsettings')
  })
})

describe('readVoucherPeekUnderlag', () => {
  const attached = { id: 'doc-1', file_name: 'receipt.pdf', mime_type: 'application/pdf' }

  it('lists the attached files, then the retained document of a supplier invoice the verifikat refers to', async () => {
    const request = api({
      '/api/documents': () => json({ data: [attached], count: 1 }),
      '/references': () =>
        json({
          data: {
            references: [
              { type: 'supplier_invoice', id: 'si-1', number: 'F-100', document_id: 'doc-2' },
              { type: 'invoice', id: 'inv-1', number: '1001' },
            ],
            owned_by: null,
          },
        }),
    })
    expect(await readVoucherPeekUnderlag('entry-1', request)).toEqual({
      state: 'ready',
      documents: [
        { id: 'doc-1', source: 'entry', fileName: 'receipt.pdf' },
        { id: 'doc-2', source: 'supplier_invoice', invoiceNumber: 'F-100' },
      ],
      none: false,
    })
    expect(request.mock.calls.map(([url]) => url)).toEqual([
      '/api/documents?journal_entry_id=entry-1&current_only=true',
      '/api/bookkeeping/journal-entries/entry-1/references',
    ])
  })

  it('lists a supplier invoice document once when it is also attached to the verifikat', async () => {
    const request = api({
      '/api/documents': () => json({ data: [attached] }),
      '/references': () =>
        json({ data: { references: [{ type: 'supplier_invoice', id: 'si-1', number: null, document_id: 'doc-1' }] } }),
    })
    const read = await readVoucherPeekUnderlag('entry-1', request)
    expect(read).toMatchObject({ state: 'ready', documents: [{ id: 'doc-1', source: 'entry' }] })
  })

  it('says none only when there is no document and no linked record', async () => {
    const empty = api({
      '/api/documents': () => json({ data: [] }),
      '/references': () => json({ data: { references: [], owned_by: null } }),
    })
    expect(await readVoucherPeekUnderlag('entry-1', empty)).toEqual({ state: 'ready', documents: [], none: true })

    const linkedOnly = api({
      '/api/documents': () => json({ data: [] }),
      '/references': () => json({ data: { references: [{ type: 'invoice', id: 'inv-1', number: '1001' }] } }),
    })
    expect(await readVoucherPeekUnderlag('entry-1', linkedOnly)).toEqual({ state: 'ready', documents: [], none: false })
  })

  it('still lists the attached files when the linked records cannot be read, without saying none', async () => {
    const withFile = api({
      '/api/documents': () => json({ data: [attached] }),
      '/references': () => json({ error: 'down' }, 500),
    })
    expect(await readVoucherPeekUnderlag('entry-1', withFile)).toMatchObject({
      state: 'ready',
      documents: [{ id: 'doc-1' }],
      none: false,
    })

    const withoutFile = api({
      '/api/documents': () => json({ data: [] }),
      '/references': () => json({ error: 'down' }, 500),
    })
    expect(await readVoucherPeekUnderlag('entry-1', withoutFile)).toEqual({ state: 'ready', documents: [], none: false })
  })

  it('still lists the attached files when the linked records read never answers, or answers something unreadable', async () => {
    const offline = api({
      '/api/documents': () => json({ data: [attached] }),
      '/references': () => {
        throw new Error('offline')
      },
    })
    expect(await readVoucherPeekUnderlag('entry-1', offline)).toMatchObject({
      state: 'ready',
      documents: [{ id: 'doc-1' }],
      none: false,
    })

    const unreadable = api({
      '/api/documents': () => json({ data: [attached] }),
      '/references': () => new Response('<html>', { status: 200 }),
    })
    expect(await readVoucherPeekUnderlag('entry-1', unreadable)).toMatchObject({
      state: 'ready',
      documents: [{ id: 'doc-1' }],
      none: false,
    })
  })

  it('fails when the document list cannot be read', async () => {
    const request = api({
      '/api/documents': () => json({ error: 'down' }, 500),
      '/references': () => json({ data: { references: [] } }),
    })
    expect(await readVoucherPeekUnderlag('entry-1', request)).toEqual({ state: 'failed' })
  })

  it('fails when the request never answers', async () => {
    const request = vi.fn(async (): Promise<Response> => {
      throw new Error('offline')
    })
    expect(await readVoucherPeekUnderlag('entry-1', request)).toEqual({ state: 'failed' })
  })
})
