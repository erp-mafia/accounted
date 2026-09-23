import { describe, expect, it } from 'vitest'
import {
  annotateUnmatchedReportDetail,
  isDestructiveDeliveryStatus,
  maskAddressToDomain,
  unmatchedReportRecipients,
} from '@/lib/invoices/delivery-recipient-statuses'

const row = {
  to_addresses: ['Customer@Example.com'],
  cc_addresses: ['copy@example.com'],
  bcc_addresses: ['archive@example.com'],
}

describe('unmatchedReportRecipients', () => {
  it('matches To, CC and BCC case-insensitively, like the RPC', () => {
    expect(
      unmatchedReportRecipients(row, [' customer@example.com ', 'COPY@example.com', 'archive@example.com']),
    ).toEqual([])
  })

  it('returns the addresses outside the send', () => {
    expect(unmatchedReportRecipients(row, ['customer@example.com', 'forward@other.se'])).toEqual([
      'forward@other.se',
    ])
  })
})

describe('maskAddressToDomain', () => {
  it('keeps only the domain', () => {
    expect(maskAddressToDomain('Linnea.Forward@Other.SE')).toBe('***@other.se')
  })

  it('never echoes a value without a domain', () => {
    expect(maskAddressToDomain('not-an-address')).toBe('***')
    expect(maskAddressToDomain('trailing@')).toBe('***')
  })
})

describe('annotateUnmatchedReportDetail', () => {
  it('names the domain when a bounce is for nobody in the send', () => {
    expect(
      annotateUnmatchedReportDetail('bounced', 'General bounce', ['forward@other.se'], ['forward@other.se']),
    ).toBe('General bounce (reported for ***@other.se)')
  })

  it('says so when the bounce named no recipient at all', () => {
    expect(annotateUnmatchedReportDetail('bounced', null, [], [])).toBe('(reported without a recipient)')
  })

  it('leaves the detail alone when at least one named address is in the send', () => {
    expect(
      annotateUnmatchedReportDetail('bounced', 'General bounce', ['customer@example.com', 'x@y.se'], ['x@y.se']),
    ).toBe('General bounce')
  })

  it('leaves non-destructive outcomes alone', () => {
    expect(annotateUnmatchedReportDetail('delivered', null, ['forward@other.se'], ['forward@other.se'])).toBeNull()
    expect(annotateUnmatchedReportDetail('delayed', 'Retrying', [], [])).toBe('Retrying')
  })
})

describe('isDestructiveDeliveryStatus', () => {
  it('is true only for outcomes where the invoice did not arrive', () => {
    expect(isDestructiveDeliveryStatus('bounced')).toBe(true)
    expect(isDestructiveDeliveryStatus('failed')).toBe(true)
    expect(isDestructiveDeliveryStatus('suppressed')).toBe(true)
    expect(isDestructiveDeliveryStatus('delivered')).toBe(false)
    expect(isDestructiveDeliveryStatus('sent')).toBe(false)
    expect(isDestructiveDeliveryStatus(null)).toBe(false)
  })
})
