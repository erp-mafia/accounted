import { describe, it, expect } from 'vitest'
import { minimisePayload } from '../handler'
import { makeCustomer, makeInvoice } from '@/tests/helpers'

/**
 * minimisePayload is the one projection every outbound event surface runs
 * (webhook fan-out, the webhook retry, GET /api/events). The emit sites hand
 * it whole rows with joins, so the personnummer and actor fields it drops can
 * sit at any depth: invoice.created carries the customer row and the items.
 */
describe('minimisePayload', () => {
  function invoiceCreatedPayload() {
    const customer = makeCustomer({
      id: 'cust-1',
      user_id: 'user-1',
      personal_number: '19800101-1234',
    })
    const invoice = makeInvoice({
      id: 'inv-1',
      user_id: 'user-1',
      customer_id: 'cust-1',
      deduction_total: 5000,
      deduction_personnummer_encrypted: 'v1:iv:ciphertext:tag',
      deduction_personnummer_last4: '1234',
      customer,
      items: [
        { id: 'item-1', invoice_id: 'inv-1', description: 'Städning', quantity: 1, unit_price: 10000, line_total: 10000 },
        { id: 'item-2', invoice_id: 'inv-1', description: 'Fönsterputs', quantity: 2, unit_price: 500, line_total: 1000 },
      ] as never,
    })
    return { invoice, userId: 'user-1', companyId: 'company-1' }
  }

  const STRIPPED = new Set([
    'userId',
    'user_id',
    'personal_number',
    'personnummer',
    'deduction_personnummer_encrypted',
    'deduction_personnummer_last4',
    'personnummer_encrypted',
    'personnummer_last4',
    'keepLearnedTemplates',
  ])

  function strippedKeysAnywhere(value: unknown, path = '$'): string[] {
    if (Array.isArray(value)) return value.flatMap((v, i) => strippedKeysAnywhere(v, `${path}[${i}]`))
    if (!value || typeof value !== 'object') return []
    return Object.entries(value).flatMap(([k, v]) => [
      ...(STRIPPED.has(k) ? [`${path}.${k}`] : []),
      ...strippedKeysAnywhere(v, `${path}.${k}`),
    ])
  }

  it('drops personnummer and actor fields at any depth of a full invoice.created payload', () => {
    const payload = invoiceCreatedPayload()
    // Guard the fixture: the fields really are there before the projection.
    expect(strippedKeysAnywhere(payload)).toEqual(
      expect.arrayContaining([
        '$.userId',
        '$.invoice.user_id',
        '$.invoice.deduction_personnummer_encrypted',
        '$.invoice.deduction_personnummer_last4',
        '$.invoice.customer.user_id',
        '$.invoice.customer.personal_number',
      ]),
    )

    const minimised = minimisePayload(payload as unknown as Record<string, unknown>)

    expect(strippedKeysAnywhere(minimised)).toEqual([])
  })

  it('keeps everything else, including the tenant scope, the rows and the items', () => {
    const payload = invoiceCreatedPayload()
    const minimised = minimisePayload(payload as unknown as Record<string, unknown>) as {
      companyId: string
      invoice: Record<string, unknown> & { customer: Record<string, unknown>; items: Record<string, unknown>[] }
    }

    expect(minimised.companyId).toBe('company-1')
    expect(minimised.invoice.id).toBe('inv-1')
    expect(minimised.invoice.deduction_total).toBe(5000)
    expect(minimised.invoice.customer.id).toBe('cust-1')
    expect(minimised.invoice.customer.org_number).toBe(payload.invoice.customer!.org_number)
    expect(minimised.invoice.items).toHaveLength(2)
    expect(minimised.invoice.items[1]).toEqual(payload.invoice.items![1])
  })

  it('does not mutate the in-process payload other event handlers still read', () => {
    const payload = invoiceCreatedPayload()
    minimisePayload(payload as unknown as Record<string, unknown>)

    expect(payload.userId).toBe('user-1')
    expect(payload.invoice.deduction_personnummer_encrypted).toBe('v1:iv:ciphertext:tag')
    expect(payload.invoice.customer!.personal_number).toBe('19800101-1234')
  })

  it('is idempotent on an already minimised payload (the retry path re-runs it)', () => {
    const once = minimisePayload(invoiceCreatedPayload() as unknown as Record<string, unknown>)
    expect(minimisePayload(once)).toEqual(once)
  })

  it('drops the in-process keepLearnedTemplates instruction from journal_entry.corrected', () => {
    const out = minimisePayload({ original: { id: 'je-1' }, corrected: { id: 'je-2' }, companyId: 'company-1', keepLearnedTemplates: true })
    expect(out).toEqual({ original: { id: 'je-1' }, corrected: { id: 'je-2' }, companyId: 'company-1' })
  })

  it('leaves null, primitives and arrays of primitives alone', () => {
    expect(
      minimisePayload({ companyId: 'c', entryIds: ['a', 'b'], note: null, amount: 12.5, personnummer: '19800101-1234' }),
    ).toEqual({ companyId: 'c', entryIds: ['a', 'b'], note: null, amount: 12.5 })
  })
})
