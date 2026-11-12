import { describe, expect, it } from 'vitest'
import { PEPPOL_OUTCOME_UNREPORTED_HINT, peppolDeliveryAttention, peppolOutcomeUnreported } from '../peppol-attention'

const HOUR = 60 * 60 * 1000
const acceptedAt = '2026-11-04T10:00:00.000Z'
const after = (ms: number) => Date.parse(acceptedAt) + ms

describe('peppolDeliveryAttention', () => {
  it('says nothing without a delivery or before the read time is known', () => {
    expect(peppolDeliveryAttention(null, after(HOUR * 48))).toBeNull()
    expect(peppolDeliveryAttention({ status: 'submission_accepted', status_at: acceptedAt }, null)).toBeNull()
  })

  it('says nothing for the first hour after the access point accepted the document', () => {
    expect(peppolDeliveryAttention({ status: 'submission_accepted', status_at: acceptedAt }, after(HOUR))).toBeNull()
  })

  it('is unconfirmed between an hour and a day', () => {
    const delivery = { status: 'submission_accepted', status_at: acceptedAt }
    expect(peppolDeliveryAttention(delivery, after(HOUR + 1))).toBe('unconfirmed')
    expect(peppolDeliveryAttention(delivery, after(HOUR * 24))).toBe('unconfirmed')
  })

  it('is unreported once a day has passed without an outcome', () => {
    const delivery = { status: 'submission_accepted', status_at: acceptedAt }
    expect(peppolDeliveryAttention(delivery, after(HOUR * 24 + 1))).toBe('unreported')
    expect(peppolDeliveryAttention(delivery, after(HOUR * 24 * 20))).toBe('unreported')
  })

  it('is failed for a delivery that ended without reaching the buyer, whatever its age', () => {
    expect(peppolDeliveryAttention({ status: 'failed', status_at: acceptedAt }, null)).toBe('failed')
    expect(peppolDeliveryAttention({ status: 'no_route', status_at: acceptedAt }, after(HOUR * 48))).toBe('failed')
  })

  it('says nothing once an outcome is recorded', () => {
    for (const status of ['transport_succeeded', 'recipient_acknowledged', 'business_accepted', 'business_rejected', 'staged']) {
      expect(peppolDeliveryAttention({ status, status_at: acceptedAt }, after(HOUR * 48))).toBeNull()
    }
  })
})

describe('peppolOutcomeUnreported', () => {
  it('carries the flag and the hint exactly when the page rule says unreported', () => {
    const delivery = { status: 'submission_accepted', status_at: acceptedAt }
    expect(peppolOutcomeUnreported(delivery, after(HOUR * 24 + 1))).toEqual({
      outcome_unreported: true,
      outcome_hint: PEPPOL_OUTCOME_UNREPORTED_HINT,
    })
  })

  it('adds nothing for a delivery still inside the day, a failed one or one with an outcome', () => {
    expect(peppolOutcomeUnreported({ status: 'submission_accepted', status_at: acceptedAt }, after(HOUR * 24))).toBeNull()
    expect(peppolOutcomeUnreported({ status: 'failed', status_at: acceptedAt }, after(HOUR * 48))).toBeNull()
    expect(peppolOutcomeUnreported({ status: 'transport_succeeded', status_at: acceptedAt }, after(HOUR * 48))).toBeNull()
  })
})
