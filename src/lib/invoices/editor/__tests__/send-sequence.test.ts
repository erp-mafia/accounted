import { describe, it, expect, vi } from 'vitest'
import {
  buildSendBody,
  buildSendStepBody,
  persistAndSend,
  type SendSequenceInput,
} from '@/lib/invoices/editor/send-sequence'

interface Call {
  url: string
  method: string
  body: unknown
}

/** A fetch stub answering each call in turn, recording what was asked. */
function stubFetch(responses: Array<{ status?: number; json: unknown }>) {
  const calls: Call[] = []
  const queue = [...responses]
  const fetchImpl = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({
      url,
      method: init?.method ?? 'GET',
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    })
    const next = queue.shift() ?? { status: 500, json: { error: 'unexpected call' } }
    return new Response(JSON.stringify(next.json), { status: next.status ?? 200 })
  })
  return { fetchImpl, calls }
}

function input(overrides: Partial<SendSequenceInput> = {}): SendSequenceInput {
  return {
    mode: 'create',
    documentType: 'invoice',
    payload: { customer_id: 'c1', items: [] },
    channel: 'email',
    ...overrides,
  }
}

describe('persistAndSend', () => {
  it('creates the document, then emails it', async () => {
    const { fetchImpl, calls } = stubFetch([
      { json: { data: { id: 'inv-1', invoice_number: '1043' } } },
      { json: { success: true, message: 'Fakturan har skickats' } },
    ])
    const result = await persistAndSend(input(), fetchImpl)
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['POST', '/api/invoices'],
      ['POST', '/api/invoices/inv-1/send'],
    ])
    expect(calls[0].body).toEqual({ customer_id: 'c1', items: [] })
    // An untouched send posts no body: the server builds everything itself.
    expect(calls[1].body).toBeUndefined()
    expect(result).toEqual({
      ok: true,
      invoiceId: 'inv-1',
      invoiceNumber: '1043',
      partial: false,
      message: 'Fakturan har skickats',
    })
  })

  it('passes this send’s copies and texts to the send route', async () => {
    const { fetchImpl, calls } = stubFetch([
      { json: { data: { id: 'inv-1', invoice_number: '1043' } } },
      { json: { success: true } },
    ])
    await persistAndSend(
      input({ email: { additional_cc: ['kopia@example.se'], email_subject: 'Ämne', email_body: 'Hej' } }),
      fetchImpl,
    )
    expect(calls[1].body).toEqual({
      additional_cc: ['kopia@example.se'],
      email_subject: 'Ämne',
      email_body: 'Hej',
    })
  })

  it('marks as sent on the manual channel', async () => {
    const { fetchImpl, calls } = stubFetch([
      { json: { data: { id: 'inv-1', invoice_number: '1043' } } },
      { json: { success: true, status: 'sent', partial: true } },
    ])
    const result = await persistAndSend(input({ channel: 'manual', email: { email_subject: 'ignored' } }), fetchImpl)
    expect(calls[1]).toMatchObject({ method: 'POST', url: '/api/invoices/inv-1/mark-sent', body: undefined })
    expect(result).toMatchObject({ ok: true, partial: true })
  })

  it('sends an e-faktura on the Peppol channel, never a mark-sent', async () => {
    const { fetchImpl, calls } = stubFetch([
      { json: { data: { id: 'inv-1', invoice_number: '1043' } } },
      { json: { data: { network_submitted: true } } },
    ])
    const result = await persistAndSend(input({ channel: 'peppol', email: { email_subject: 'ignored' } }), fetchImpl)
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ['POST', '/api/invoices', { customer_id: 'c1', items: [] }],
      ['POST', '/api/invoices/inv-1/peppol/send', undefined],
    ])
    expect(calls.some((c) => c.url.endsWith('/mark-sent'))).toBe(false)
    expect(result).toEqual({ ok: true, invoiceId: 'inv-1', invoiceNumber: '1043', partial: false, message: null })
  })

  it('sends to the customer’s Kivra or Billo mailbox with the provider, never a mark-sent or the email texts', async () => {
    for (const channel of ['kivra', 'billo'] as const) {
      const { fetchImpl, calls } = stubFetch([
        { json: { data: { id: 'inv-1', invoice_number: '1043' } } },
        { json: { data: { dispatch_id: 'd-1', provider: channel, issued: true, journal_entry_id: 'je-1' } } },
      ])
      const result = await persistAndSend(input({ channel, email: { email_subject: 'ignored' } }), fetchImpl)
      expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
        ['POST', '/api/invoices', { customer_id: 'c1', items: [] }],
        ['POST', '/api/invoices/inv-1/digital-mailbox/send', { provider: channel }],
      ])
      expect(result).toEqual({ ok: true, invoiceId: 'inv-1', invoiceNumber: '1043', partial: false, message: null })
    }
  })

  it('saves and finalizes an edited draft before the mailbox send', async () => {
    const { fetchImpl, calls } = stubFetch([
      { json: { data: { id: 'inv-9' } } },
      { json: { data: { id: 'inv-9', invoice_number: '1050' } } },
      { json: { data: { dispatch_id: 'd-1', provider: 'kivra', issued: true } } },
    ])
    const result = await persistAndSend(
      input({ mode: 'edit', invoiceId: 'inv-9', invoiceNumber: null, channel: 'kivra' }),
      fetchImpl,
    )
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['PATCH', '/api/invoices/inv-9'],
      ['POST', '/api/invoices/inv-9/finalize'],
      ['POST', '/api/invoices/inv-9/digital-mailbox/send'],
    ])
    expect(result).toMatchObject({ ok: true, invoiceId: 'inv-9', invoiceNumber: '1050' })
  })

  it('reports a mailbox refusal with the saved document, so the detail page takes over', async () => {
    const refusal = {
      error: {
        code: 'DIGITAL_MAILBOX_RECIPIENT_NOT_REACHABLE',
        message: 'Mottagaren har ingen brevlåda som tar emot från ert företag. Skicka fakturan på annat sätt.',
        message_en: 'The recipient has no mailbox that accepts content from your company. Deliver the invoice another way.',
      },
    }
    const { fetchImpl } = stubFetch([
      { json: { data: { id: 'inv-1', invoice_number: '1043' } } },
      { status: 422, json: refusal },
    ])
    const result = await persistAndSend(input({ channel: 'billo' }), fetchImpl)
    expect(result).toEqual({ ok: false, stage: 'send', invoiceId: 'inv-1', status: 422, error: refusal })
  })

  it('saves an edited unnumbered faktura, finalizes it, then sends', async () => {
    const { fetchImpl, calls } = stubFetch([
      { json: { data: { id: 'inv-9' } } },
      { json: { data: { id: 'inv-9', invoice_number: '1050' } } },
      { json: { success: true } },
    ])
    const result = await persistAndSend(
      input({ mode: 'edit', invoiceId: 'inv-9', invoiceNumber: null }),
      fetchImpl,
    )
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['PATCH', '/api/invoices/inv-9'],
      ['POST', '/api/invoices/inv-9/finalize'],
      ['POST', '/api/invoices/inv-9/send'],
    ])
    expect(result).toMatchObject({ ok: true, invoiceId: 'inv-9', invoiceNumber: '1050' })
  })

  it('does not finalize a numbered draft or a quote', async () => {
    const numbered = stubFetch([{ json: { data: {} } }, { json: { success: true } }])
    await persistAndSend(input({ mode: 'edit', invoiceId: 'inv-9', invoiceNumber: '1049' }), numbered.fetchImpl)
    expect(numbered.calls.map((c) => c.url)).toEqual(['/api/invoices/inv-9', '/api/invoices/inv-9/send'])

    const quote = stubFetch([{ json: { data: {} } }, { json: { success: true } }])
    await persistAndSend(
      input({ mode: 'edit', invoiceId: 'q-1', invoiceNumber: null, documentType: 'quote' }),
      quote.fetchImpl,
    )
    expect(quote.calls.map((c) => c.url)).toEqual(['/api/invoices/q-1', '/api/invoices/q-1/send'])
  })

  it('stops at a failed save and reports no document', async () => {
    const { fetchImpl, calls } = stubFetch([{ status: 400, json: { error: { code: 'VALIDATION_ERROR' } } }])
    const result = await persistAndSend(input(), fetchImpl)
    expect(calls).toHaveLength(1)
    expect(result).toEqual({
      ok: false,
      stage: 'persist',
      invoiceId: null,
      status: 400,
      error: { error: { code: 'VALIDATION_ERROR' } },
    })
  })

  it('reports the saved document when the send fails, so the editor does not create it twice', async () => {
    const { fetchImpl } = stubFetch([
      { json: { data: { id: 'inv-1', invoice_number: '1043' } } },
      { status: 502, json: { error: { code: 'INVOICE_SEND_EMAIL_FAILED' } } },
    ])
    const result = await persistAndSend(input(), fetchImpl)
    expect(result).toMatchObject({ ok: false, stage: 'send', invoiceId: 'inv-1', status: 502 })
  })

  it('reports the created document when the send request never gets an answer', async () => {
    // Offline after the create: the fetch rejects instead of answering. The
    // sequence must still resolve with the id, or the editor stays busy and a
    // reload creates the invoice a second time.
    const calls: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      calls.push(url)
      if (url === '/api/invoices') {
        return new Response(JSON.stringify({ data: { id: 'inv-1', invoice_number: '1043' } }), { status: 201 })
      }
      throw new TypeError('Failed to fetch')
    })
    const result = await persistAndSend(input(), fetchImpl)
    expect(calls).toEqual(['/api/invoices', '/api/invoices/inv-1/send'])
    expect(result).toMatchObject({ ok: false, stage: 'send', invoiceId: 'inv-1', status: 0 })
    expect(result.ok === false && result.error).toBeInstanceOf(TypeError)
  })

  it('reports a rejected create as a failed save with no document', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    })
    const result = await persistAndSend(input(), fetchImpl)
    expect(result).toMatchObject({ ok: false, stage: 'persist', invoiceId: null, status: 0 })
  })

  it('reports a rejected finalize with the draft id', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.endsWith('/finalize')) throw new TypeError('Failed to fetch')
      return new Response(JSON.stringify({ data: {} }), { status: 200 })
    })
    const result = await persistAndSend(input({ mode: 'edit', invoiceId: 'inv-9', invoiceNumber: null }), fetchImpl)
    expect(result).toMatchObject({ ok: false, stage: 'finalize', invoiceId: 'inv-9', status: 0 })
  })

  it('reports a failed finalize with the draft id', async () => {
    const { fetchImpl } = stubFetch([{ json: { data: {} } }, { status: 409, json: { error: { code: 'X' } } }])
    const result = await persistAndSend(input({ mode: 'edit', invoiceId: 'inv-9', invoiceNumber: null }), fetchImpl)
    expect(result).toMatchObject({ ok: false, stage: 'finalize', invoiceId: 'inv-9', status: 409 })
  })
})

describe('persistAndSend: files picked in the editor confirm (#79, crm#1315, PH 198)', () => {
  const doc1 = '11111111-1111-4111-8111-111111111111'
  const doc2 = '22222222-2222-4222-8222-222222222222'

  it('links the files to the created draft, then emails it', async () => {
    const { fetchImpl, calls } = stubFetch([
      { json: { data: { id: 'inv-1', invoice_number: '1043' } } },
      { json: { data: [{ document_id: doc1 }, { document_id: doc2 }] } },
      { json: { success: true, message: 'Fakturan har skickats' } },
    ])
    const result = await persistAndSend(input({ attachmentDocumentIds: [doc1, doc2] }), fetchImpl)
    expect(calls.map((c) => [c.method, c.url, c.body])).toEqual([
      ['POST', '/api/invoices', { customer_id: 'c1', items: [] }],
      ['POST', '/api/invoices/inv-1/attachments', { document_ids: [doc1, doc2] }],
      ['POST', '/api/invoices/inv-1/send', undefined],
    ])
    expect(result).toMatchObject({ ok: true, invoiceId: 'inv-1', invoiceNumber: '1043' })
  })

  it('links after the finalize of an edited unnumbered draft', async () => {
    const { fetchImpl, calls } = stubFetch([
      { json: { data: { id: 'inv-9' } } },
      { json: { data: { id: 'inv-9', invoice_number: '1050' } } },
      { json: { data: [{ document_id: doc1 }] } },
      { json: { success: true } },
    ])
    await persistAndSend(
      input({ mode: 'edit', invoiceId: 'inv-9', invoiceNumber: null, attachmentDocumentIds: [doc1] }),
      fetchImpl,
    )
    expect(calls.map((c) => c.url)).toEqual([
      '/api/invoices/inv-9',
      '/api/invoices/inv-9/finalize',
      '/api/invoices/inv-9/attachments',
      '/api/invoices/inv-9/send',
    ])
  })

  it('stops before the send when the files cannot be linked, and reports the saved draft', async () => {
    // Nothing is sent or booked: the draft exists with its number, and the
    // invoice page takes over (its send dialog shows Bilagor again).
    const { fetchImpl, calls } = stubFetch([
      { json: { data: { id: 'inv-1', invoice_number: '1043' } } },
      { status: 400, json: { error: { code: 'INVOICE_ATTACHMENTS_TOO_LARGE' } } },
    ])
    const result = await persistAndSend(input({ attachmentDocumentIds: [doc1] }), fetchImpl)
    expect(calls.map((c) => c.url)).toEqual(['/api/invoices', '/api/invoices/inv-1/attachments'])
    expect(result).toEqual({
      ok: false,
      stage: 'attach',
      invoiceId: 'inv-1',
      status: 400,
      error: { error: { code: 'INVOICE_ATTACHMENTS_TOO_LARGE' } },
    })
  })

  it('reports the saved draft when the link request never gets an answer', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url === '/api/invoices') {
        return new Response(JSON.stringify({ data: { id: 'inv-1', invoice_number: '1043' } }), { status: 201 })
      }
      throw new TypeError('Failed to fetch')
    })
    const result = await persistAndSend(input({ attachmentDocumentIds: [doc1] }), fetchImpl)
    expect(result).toMatchObject({ ok: false, stage: 'attach', invoiceId: 'inv-1', status: 0 })
  })

  it('posts no link step without files', async () => {
    const { fetchImpl, calls } = stubFetch([
      { json: { data: { id: 'inv-1', invoice_number: '1043' } } },
      { json: { success: true } },
    ])
    await persistAndSend(input({ attachmentDocumentIds: [] }), fetchImpl)
    expect(calls.map((c) => c.url)).toEqual(['/api/invoices', '/api/invoices/inv-1/send'])
  })

  it('never links on a channel that does not email them (the set would be fixed unsent)', async () => {
    for (const channel of ['manual', 'peppol'] as const) {
      const { fetchImpl, calls } = stubFetch([
        { json: { data: { id: 'inv-1', invoice_number: '1043' } } },
        { json: { success: true } },
      ])
      await persistAndSend(input({ channel, attachmentDocumentIds: [doc1] }), fetchImpl)
      expect(calls.some((c) => c.url.endsWith('/attachments'))).toBe(false)
    }
    const paid = stubFetch([
      { json: { data: { id: 'inv-1', invoice_number: '1043' } } },
      { json: { success: true } },
      { json: { success: true } },
    ])
    await persistAndSend(
      input({ paidAtIssue: { account_number: '1930' }, attachmentDocumentIds: [doc1] }),
      paid.fetchImpl,
    )
    expect(paid.calls.some((c) => c.url.endsWith('/attachments'))).toBe(false)
  })
})

describe('buildSendBody', () => {
  it('keeps only what carries something', () => {
    expect(buildSendBody(undefined)).toBeNull()
    expect(buildSendBody({ additional_cc: [], email_subject: '  ', email_body: '' })).toBeNull()
    expect(buildSendBody({ email_body: 'Hej' })).toEqual({ email_body: 'Hej' })
  })
})

describe('buildSendStepBody', () => {
  it('carries the email texts on the email channel only', () => {
    expect(buildSendStepBody('email', { email_subject: 'Ämne' })).toEqual({ email_subject: 'Ämne' })
    expect(buildSendStepBody('email', undefined)).toBeNull()
    expect(buildSendStepBody('manual', { email_subject: 'Ämne' })).toBeNull()
    expect(buildSendStepBody('peppol', { email_subject: 'Ämne' })).toBeNull()
  })

  it('names the provider on a mailbox channel', () => {
    expect(buildSendStepBody('kivra', { email_subject: 'Ämne' })).toEqual({ provider: 'kivra' })
    expect(buildSendStepBody('billo', undefined)).toEqual({ provider: 'billo' })
  })
})

describe('persistAndSend: kontantfaktura, paid at issue (crm#1281)', () => {
  const paid = { account_number: '1930' }

  it('creates, issues it paid, then mails the receipt', async () => {
    const { fetchImpl, calls } = stubFetch([
      { json: { data: { id: 'inv-1', invoice_number: '1043' } } },
      { json: { success: true, status: 'paid', journal_entry_id: 'je-1' } },
      { json: { success: true } },
    ])
    const result = await persistAndSend(input({ paidAtIssue: paid }), fetchImpl)
    expect(calls.map((c) => [c.method, c.url])).toEqual([
      ['POST', '/api/invoices'],
      ['POST', '/api/invoices/inv-1/mark-sent'],
      ['POST', '/api/invoices/inv-1/send-payment-confirmation'],
    ])
    // Never the send route: it would email an unpaid invoice.
    expect(calls[1].body).toEqual({ paid_at_issue: { account_number: '1930' } })
    expect(result).toEqual({
      ok: true,
      invoiceId: 'inv-1',
      invoiceNumber: '1043',
      partial: false,
      message: null,
      receiptFailed: false,
    })
  })

  it('mails nothing when the user hands the receipt over', async () => {
    const { fetchImpl, calls } = stubFetch([
      { json: { data: { id: 'inv-1', invoice_number: '1043' } } },
      { json: { success: true, status: 'paid' } },
    ])
    const result = await persistAndSend(input({ channel: 'manual', paidAtIssue: paid }), fetchImpl)
    expect(calls.map((c) => c.url)).toEqual(['/api/invoices', '/api/invoices/inv-1/mark-sent'])
    expect(result).toMatchObject({ ok: true, invoiceId: 'inv-1', partial: false })
  })

  it('reports a failed receipt mail without undoing the issued, booked invoice', async () => {
    const { fetchImpl } = stubFetch([
      { json: { data: { id: 'inv-1', invoice_number: '1043' } } },
      { json: { success: true, status: 'paid' } },
      { status: 503, json: { error: { code: 'INVOICE_SEND_EMAIL_NOT_CONFIGURED' } } },
    ])
    const result = await persistAndSend(input({ paidAtIssue: paid }), fetchImpl)
    expect(result).toMatchObject({ ok: true, invoiceId: 'inv-1', receiptFailed: true })
  })

  it('stops at the issue when the payment cannot be booked (the draft stays)', async () => {
    const refusal = { error: { code: 'INVOICE_PAID_NO_FISCAL_PERIOD' } }
    const { fetchImpl, calls } = stubFetch([
      { json: { data: { id: 'inv-1', invoice_number: '1043' } } },
      { status: 400, json: refusal },
    ])
    const result = await persistAndSend(input({ paidAtIssue: paid }), fetchImpl)
    expect(calls).toHaveLength(2)
    expect(result).toEqual({ ok: false, stage: 'send', invoiceId: 'inv-1', status: 400, error: refusal })
  })
})

