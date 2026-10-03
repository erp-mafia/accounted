import { describe, expect, it } from 'vitest'
import {
  CONTRACT_VERSION,
  DELIVERY_OPERATIONS,
  DELIVERY_START_OPERATIONS,
  deliveryFeaturesSchema,
  deliveryMethodSchema,
  deliveryMethodsRequestSchema,
  deliveryReceiptSchema,
  deliverySendRequestSchema,
  deliveryStatusSchema,
} from '../index'
import { DELIVERY_FIXTURES, TEST_ORG_NUMBER, TEST_PERSONAL_NUMBER, businessDebtor, collectionsCase, deliveryFeatures, deliverySendRequest, privateDebtor } from './fixtures'

const send = (patch: Record<string, unknown>) => deliverySendRequestSchema.safeParse({ ...deliverySendRequest, ...patch })
const abroad = (debtor: typeof privateDebtor) => ({ ...debtor, address: { ...debtor.address, countryCode: 'NO' } })

describe('delivery family', () => {
  it('shares the dated contract version', () => {
    expect(CONTRACT_VERSION).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('treats the lookup and the send as start work and the status read as an obligation', () => {
    expect(DELIVERY_START_OPERATIONS).toEqual(['methods', 'send'])
    for (const op of DELIVERY_START_OPERATIONS) expect(Object.keys(DELIVERY_OPERATIONS)).toContain(op)
    expect(DELIVERY_START_OPERATIONS).not.toContain('status')
  })

  it('names three methods and offers follow-up modes never, optional and always', () => {
    expect(deliveryMethodSchema.options).toEqual(['post', 'kivra', 'einvoice_bank'])
    for (const followUp of ['never', 'optional', 'always']) {
      expect(deliveryFeaturesSchema.safeParse({ ...deliveryFeatures, followUp }).success, followUp).toBe(true)
    }
    expect(deliveryFeaturesSchema.safeParse({ ...deliveryFeatures, maxDocumentChars: 0 }).success).toBe(false)
  })
})

describe('method lookup', () => {
  const lookup = DELIVERY_FIXTURES.methods.request

  it('carries identifiers only: a name or an address never leaves with a lookup', () => {
    const parsed = deliveryMethodsRequestSchema.parse({
      ...lookup,
      debtor: { ...lookup.debtor, name: 'Tolvan Tolvansson', address: privateDebtor.address },
    })
    expect(parsed.debtor).toEqual({ kind: 'private', orgNumber: null, personalNumber: TEST_PERSONAL_NUMBER })
  })

  it('needs the identifier that matches the kind of debtor', () => {
    expect(deliveryMethodsRequestSchema.safeParse({ ...lookup, debtor: { kind: 'private', orgNumber: TEST_ORG_NUMBER, personalNumber: null } }).success).toBe(false)
    expect(deliveryMethodsRequestSchema.safeParse({ ...lookup, debtor: { kind: 'business', orgNumber: null, personalNumber: null } }).success).toBe(false)
    expect(deliveryMethodsRequestSchema.safeParse({ ...lookup, debtor: { kind: 'business', orgNumber: TEST_ORG_NUMBER, personalNumber: null } }).success).toBe(true)
  })

  it('looks up the digital channels only: post needs no lookup', () => {
    expect(deliveryMethodsRequestSchema.safeParse({ ...lookup, method: 'post' }).success).toBe(false)
    expect(deliveryMethodsRequestSchema.safeParse({ ...lookup, method: 'einvoice_bank' }).success).toBe(true)
  })

  it('refuses a malformed personal identity number', () => {
    expect(deliveryMethodsRequestSchema.safeParse({ ...lookup, debtor: { ...lookup.debtor, personalNumber: '121212-1212' } }).success).toBe(false)
  })
})

describe('send', () => {
  it('sends by post to any debtor with a full address', () => {
    expect(send({ method: 'post', debtor: businessDebtor }).success).toBe(true)
    expect(send({ method: 'post', debtor: abroad({ ...privateDebtor, personalNumber: null }) }).success).toBe(true)
  })

  it('needs the identifier a digital channel delivers to, wherever the debtor lives', () => {
    expect(send({ method: 'kivra', debtor: abroad({ ...privateDebtor, personalNumber: null }) }).success).toBe(false)
    expect(send({ method: 'einvoice_bank', debtor: abroad({ ...businessDebtor, orgNumber: null }) }).success).toBe(false)
    expect(send({ method: 'kivra', debtor: businessDebtor }).success).toBe(true)
  })

  it('checks the invoice like a handover does', () => {
    expect(send({ invoice: { ...deliverySendRequest.invoice, claimAmount: 99.999 } }).success).toBe(false)
    expect(send({ invoice: { ...deliverySendRequest.invoice, dueDate: '2026-07-01' } }).success).toBe(false)
  })

  it('registers follow-up only when asked, keyed by the watching case row', () => {
    expect(send({ followUp: { caseIdempotencyKey: 'case-1', reminderFeeAgreed: false } }).success).toBe(true)
    expect(send({ followUp: { caseIdempotencyKey: '', reminderFeeAgreed: false } }).success).toBe(false)
    expect(send({ followUp: undefined }).success).toBe(false)
  })

  it('returns the watching case with the receipt when follow-up was registered', () => {
    const receipt = { ...DELIVERY_FIXTURES.send.response, case: { ...collectionsCase, stage: 'invoice_sent', actions: ['start'] } }
    expect(deliveryReceiptSchema.safeParse(receipt).success).toBe(true)
    expect(deliveryReceiptSchema.safeParse({ ...receipt, deliveryRef: '' }).success).toBe(false)
  })
})

describe('status', () => {
  it('reports each delivery state and refuses others', () => {
    const status = DELIVERY_FIXTURES.status.response[0]
    for (const state of ['scheduled', 'sent', 'delivered', 'failed', 'returned']) {
      expect(deliveryStatusSchema.safeParse({ ...status, state }).success, state).toBe(true)
    }
    expect(deliveryStatusSchema.safeParse({ ...status, state: 'read' }).success).toBe(false)
  })
})
