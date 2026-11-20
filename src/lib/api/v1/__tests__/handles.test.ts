import { describe, expect, it } from 'vitest'
import { NextResponse } from 'next/server'
import { addHandles, normalizeV1Handles, withHandleSchema, withResponseHandles } from '../handles'
import type { JsonSchema } from '../registry'

const JE_ID = '0e9c41d2-a1b0-4c6f-9a3e-5b7d8c9f0a1b'
const JE = 'je_0e9c41d2a1b04c6f9a3e5b7d8c9f0a1b'
const INV_ID = '7b3a0000-1111-4222-8333-444455556666'
const INV = 'inv_7b3a0000111142228333444455556666'
const COMPANY = '8fd5b1f4-0000-4000-8000-000000000001'
const CMP = 'cmp_8fd5b1f4000040008000000000000001'

describe('addHandles', () => {
  it('puts handle right after the id and changes nothing else', () => {
    const data = { id: JE_ID, voucher_number: 7, status: 'posted' }
    const r = addHandles(data, { type: 'journal_entry' })
    expect(r.changed).toBe(true)
    expect(Object.keys(r.value as object)).toEqual(['id', 'handle', 'voucher_number', 'status'])
    expect(r.value).toEqual({ id: JE_ID, handle: JE, voucher_number: 7, status: 'posted' })
    expect(data).toEqual({ id: JE_ID, voucher_number: 7, status: 'posted' })
  })

  it('stamps every row of a list, a wrapped list and a qualified id field', () => {
    expect(addHandles([{ id: JE_ID }, { id: JE_ID }], { type: 'journal_entry' }).value).toEqual([
      { id: JE_ID, handle: JE },
      { id: JE_ID, handle: JE },
    ])
    expect(
      addHandles({ fiscal_periods: [{ id: JE_ID }], next_cursor: null }, { type: 'fiscal_period', at: 'fiscal_periods' }).value,
    ).toEqual({ fiscal_periods: [{ id: JE_ID, handle: 'fp_0e9c41d2a1b04c6f9a3e5b7d8c9f0a1b' }], next_cursor: null })
    expect(
      addHandles({ pending_operation_id: JE_ID, status: 'pending' }, { type: 'pending_operation', idField: 'pending_operation_id' }).value,
    ).toEqual({ pending_operation_id: JE_ID, handle: 'pop_0e9c41d2a1b04c6f9a3e5b7d8c9f0a1b', status: 'pending' })
  })

  it('never overwrites a handle field and never stamps a non-UUID id', () => {
    const own = { id: JE_ID, handle: '@acme' }
    expect(addHandles(own, { type: 'customer' })).toEqual({ value: own, changed: false })
    const odd = { id: 'not-a-uuid' }
    expect(addHandles(odd, { type: 'customer' })).toEqual({ value: odd, changed: false })
    const preview = { dry_run: true, preview: { id: JE_ID } }
    expect(addHandles(preview, { type: 'journal_entry' })).toEqual({ value: preview, changed: false })
  })
})

describe('withResponseHandles', () => {
  it('stamps a 200/201 JSON body, keeping status, headers and meta', async () => {
    const res = NextResponse.json({ data: { id: INV_ID }, meta: { request_id: 'req_1' } }, { status: 201 })
    res.headers.set('X-Request-Id', 'req_1')
    const out = await withResponseHandles(res, { type: 'invoice' })
    expect(out.status).toBe(201)
    expect(out.headers.get('X-Request-Id')).toBe('req_1')
    expect(await out.json()).toEqual({ data: { id: INV_ID, handle: INV }, meta: { request_id: 'req_1' } })
  })

  it('answers the same response when there is nothing to stamp or it is not a resource body', async () => {
    const error = NextResponse.json({ error: { code: 'NOT_FOUND' } }, { status: 404 })
    expect(await withResponseHandles(error, { type: 'invoice' })).toBe(error)
    const staged = NextResponse.json({ data: { id: INV_ID } }, { status: 202 })
    expect(await withResponseHandles(staged, { type: 'invoice' })).toBe(staged)
    const pdf = new NextResponse('%PDF', { status: 200, headers: { 'content-type': 'application/pdf' } })
    expect(await withResponseHandles(pdf, { type: 'invoice' })).toBe(pdf)
    const noId = NextResponse.json({ data: { deleted: true } })
    expect(await withResponseHandles(noId, { type: 'invoice' })).toBe(noId)
  })
})

describe('withHandleSchema', () => {
  const object = (properties: Record<string, JsonSchema>): JsonSchema => ({ type: 'object', properties })

  it('publishes handle after the id of the declared resource', () => {
    const schema = object({ data: { type: 'array', items: object({ id: { type: 'string' }, name: { type: 'string' } }) }, meta: object({}) })
    const out = withHandleSchema(schema, { type: 'customer' })
    const items = out.properties!.data!.items!
    expect(Object.keys(items.properties!)).toEqual(['id', 'handle', 'name'])
    expect(items.properties!.handle).toMatchObject({ type: 'string', pattern: '^cus_[0-9a-f]{32}$' })
    expect(items.required).toBeUndefined()
  })

  it('follows `at` and leaves a schema without the declared id untouched', () => {
    const wrapped = object({ data: object({ fiscal_period: object({ id: { type: 'string' } }) }) })
    expect(
      withHandleSchema(wrapped, { type: 'fiscal_period', at: 'fiscal_period' }).properties!.data!.properties!.fiscal_period!.properties!.handle,
    ).toBeDefined()
    const noId = object({ data: object({ deleted: { type: 'boolean' } }) })
    expect(withHandleSchema(noId, { type: 'invoice' })).toBe(noId)
    expect(withHandleSchema(noId, undefined)).toBe(noId)
  })
})

describe('normalizeV1Handles', () => {
  const url = (path: string) => `https://x.test${path}`

  it('passes a request without handles on as the very same Request and params', async () => {
    const request = new Request(url(`/api/v1/companies/${COMPANY}/journal-entries?customer_id=${INV_ID}`), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ journal_entry_id: JE_ID }),
    })
    const params = { companyId: COMPANY }
    const r = await normalizeV1Handles(request, params)
    expect(r.ok && r.request).toBe(request)
    expect(r.ok && r.params).toBe(params)
    expect(r).toMatchObject({ ok: true, changed: false, path: `/api/v1/companies/${COMPANY}/journal-entries` })
    // The body is still readable by the handler.
    expect(await request.json()).toEqual({ journal_entry_id: JE_ID })
  })

  it('replaces handles in the path, the params, the query and the JSON body', async () => {
    const request = new Request(url(`/api/v1/companies/${CMP}/journal-entries/${JE}/reverse?invoice_id=${INV}&q=${JE}`), {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'Idempotency-Key': 'k1' },
      body: JSON.stringify({ invoice_id: INV, entry_date: '2026-05-01' }),
    })
    const r = await normalizeV1Handles(request, { companyId: CMP, id: JE })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.changed).toBe(true)
    expect(r.params).toEqual({ companyId: COMPANY, id: JE_ID })
    expect(r.path).toBe(`/api/v1/companies/${COMPANY}/journal-entries/${JE_ID}/reverse`)
    const next = new URL(r.request.url)
    expect(next.pathname).toBe(r.path)
    expect(next.searchParams.get('invoice_id')).toBe(INV_ID)
    expect(next.searchParams.get('q')).toBe(JE)
    expect(r.request.method).toBe('POST')
    expect(r.request.headers.get('Idempotency-Key')).toBe('k1')
    expect(await r.request.json()).toEqual({ invoice_id: INV_ID, entry_date: '2026-05-01' })
  })

  it('reads a body sent without a JSON content type, as v1 routes do', async () => {
    const request = new Request(url(`/api/v1/companies/${COMPANY}/transactions/x/link-journal-entry`), {
      method: 'POST',
      body: JSON.stringify({ journal_entry_id: JE }),
    })
    const r = await normalizeV1Handles(request, { companyId: COMPANY })
    expect(r.ok && (await r.request.json())).toEqual({ journal_entry_id: JE_ID })
  })

  it('replaces handles in multipart text fields and carries the file over', async () => {
    const form = new FormData()
    form.set('file', new File(['%PDF-1.4'], 'kvitto.pdf', { type: 'application/pdf' }))
    form.set('journal_entry_id', JE)
    form.set('description', JE)
    const request = new Request(url(`/api/v1/companies/${COMPANY}/documents`), { method: 'POST', body: form })
    const r = await normalizeV1Handles(request, { companyId: COMPANY })
    expect(r.ok && r.changed).toBe(true)
    if (!r.ok) return
    const sent = await r.request.formData()
    expect(sent.get('journal_entry_id')).toBe(JE_ID)
    expect(sent.get('description')).toBe(JE)
    const file = sent.get('file') as File
    expect(file.name).toBe('kvitto.pdf')
    expect(await file.text()).toBe('%PDF-1.4')
  })

  it('passes a multipart body without handles on as the same Request, and refuses a wrong-type one', async () => {
    const plain = new FormData()
    plain.set('journal_entry_id', JE_ID)
    const request = new Request(url(`/api/v1/companies/${COMPANY}/documents`), { method: 'POST', body: plain })
    const r = await normalizeV1Handles(request, { companyId: COMPANY })
    expect(r.ok && r.request).toBe(request)

    const wrong = new FormData()
    wrong.set('journal_entry_id', INV)
    const refused = await normalizeV1Handles(
      new Request(url(`/api/v1/companies/${COMPANY}/documents`), { method: 'POST', body: wrong }),
      { companyId: COMPANY },
    )
    expect(refused.ok).toBe(false)
  })

  it('collects every wrong-type handle across path, query and body', async () => {
    const request = new Request(url(`/api/v1/companies/${COMPANY}/invoices/${JE}?customer_id=${INV}`), {
      method: 'PATCH',
      body: JSON.stringify({ customer_id: JE }),
    })
    const r = await normalizeV1Handles(request, { companyId: COMPANY, id: JE })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.mismatches.map((m) => [m.field, m.expected_prefix, m.received_prefix])).toEqual([
      ['path.invoices', 'inv', 'je'],
      ['customer_id', 'cus', 'inv'],
      ['customer_id', 'cus', 'je'],
    ])
  })
})
