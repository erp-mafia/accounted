import { describe, it, expect } from 'vitest'
import { summarizeInboundEvent } from '@/extensions/general/whatsapp-inbox/lib/last-event'
import {
  COMPANY_CHOICE_EXPIRED,
  STAGED_AWAITING_COMPANY,
} from '@/extensions/general/whatsapp-inbox/lib/conversation'

function row(
  processing_status: string,
  error_message: string | null = null,
  inbox_item_id: string | null = null,
) {
  return { processing_status, error_message, inbox_item_id }
}

describe('summarizeInboundEvent', () => {
  it('maps terminal statuses to the closed panel enum', () => {
    expect(summarizeInboundEvent(row('done', null, 'item-1'))).toBe('filed')
    expect(summarizeInboundEvent(row('done'))).toBe('handled')
    expect(summarizeInboundEvent(row('received'))).toBe('processing')
    expect(summarizeInboundEvent(row('processing'))).toBe('processing')
    expect(summarizeInboundEvent(row('error', 'Media exceeds the size limit'))).toBe('failed')
  })

  it('splits skipped rows by their recorded reason', () => {
    expect(summarizeInboundEvent(row('skipped', STAGED_AWAITING_COMPANY))).toBe('awaiting_company')
    expect(summarizeInboundEvent(row('skipped', COMPANY_CHOICE_EXPIRED))).toBe('failed')
    expect(summarizeInboundEvent(row('skipped', 'Duplicate document (sha256)'))).toBe('duplicate')
    expect(summarizeInboundEvent(row('skipped', 'Rate limited'))).toBe('rate_limited')
    expect(summarizeInboundEvent(row('skipped', 'Unsupported media type: video/mp4'))).toBe(
      'unsupported',
    )
    expect(summarizeInboundEvent(row('skipped', 'Muted by stopp: message not read'))).toBe('muted')
    expect(
      summarizeInboundEvent(row('skipped', 'Stale interactive tap after the question closed')),
    ).toBe('declined')
    expect(summarizeInboundEvent(row('skipped', null))).toBe('declined')
  })
})
