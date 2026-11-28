/**
 * A send through Kivra or Billo refused while the company's sending there is
 * not active names where it stands (details.state) and what that leaves to
 * do, per state (../sending-not-active.ts).
 */
import { describe, expect, it } from 'vitest'
import { isActiveSender, sendingNotActiveRefusal } from '../sending-not-active'
import { sendingStateOf } from '../sending-status'

const request = (status: 'pending' | 'rejected') => ({
  sender_request: { ref: 'req-1', status, requested_at: '2026-11-20T10:00:00Z', requested_by: 'user-1' },
})

describe('isActiveSender', () => {
  it('is true only for sending switched on with its tenant', () => {
    expect(isActiveSender({ send_state: 'active', tenant_ref: 'tk1' })).toBe(true)
    expect(isActiveSender({ send_state: 'active', tenant_ref: null })).toBe(false)
    expect(isActiveSender({ send_state: 'off', tenant_ref: 'tk1' })).toBe(false)
    expect(isActiveSender(null)).toBe(false)
  })
})

describe('sendingNotActiveRefusal', () => {
  it('off: never switched on, an admin switches it on under Inställningar › Kopplingar', () => {
    for (const connection of [null, { send_state: 'off' as const, provider_meta: {} }, { send_state: 'ended' as const, provider_meta: {} }]) {
      const refusal = sendingNotActiveRefusal('kivra', connection)
      expect(refusal).toMatchObject({ code: 'DIGITAL_MAILBOX_SENDING_NOT_ACTIVE', details: { state: 'off' } })
      expect(refusal.messageSv).toBe(
        'Utskick via Kivra är inte påslaget för företaget. En administratör slår på det under Inställningar › Kopplingar › Kivra › Utskick av fakturor och lönebesked. Skicka med e-post så länge.',
      )
      expect(refusal.messageEn).toMatch(/^Sending through Kivra is not switched on for the company\./)
      expect(refusal.remediation.description).toMatch(/^details\.state off:/)
      expect(refusal.remediation.description).toContain('/settings/connections')
    }
  })

  it('pending: switched on and waiting for Kivra\'s approval, nothing to do but wait', () => {
    const refusal = sendingNotActiveRefusal('kivra', { send_state: 'off', provider_meta: request('pending') })
    expect(refusal.details).toEqual({ state: 'pending' })
    expect(refusal.messageSv).toMatch(/^Utskick via Kivra är påslaget men väntar på att Kivra godkänner det/)
    expect(refusal.messageSv).toContain('startar av sig själva')
    expect(refusal.messageEn).toMatch(/^Sending through Kivra is switched on and waits for Kivra to approve it/)
    expect(refusal.remediation.description).toContain('Nothing to do but wait')
    expect(refusal.remediation.description).not.toContain('/settings/connections')
  })

  it('rejected: Kivra declined, switch sending on again to ask once more, or contact us', () => {
    const refusal = sendingNotActiveRefusal('kivra', { send_state: 'off', provider_meta: request('rejected') })
    expect(refusal.details).toEqual({ state: 'rejected' })
    expect(refusal.messageSv).toMatch(/^Kivra nekade att Accounted skickar för företaget/)
    expect(refusal.messageSv).toContain('Slå på utskicken igen under Inställningar › Kopplingar › Kivra')
    expect(refusal.messageSv).toContain('kontakta oss')
    expect(refusal.messageEn).toMatch(/^Kivra declined to let Accounted send for the company/)
    expect(refusal.remediation.description).toMatch(/^details\.state rejected:/)
  })

  it('names the provider it was asked about', () => {
    expect(sendingNotActiveRefusal('billo', null).messageSv).toContain('Utskick via Billo')
  })

  it('reads a row switched on without its tenant as off: it cannot send', () => {
    expect(sendingNotActiveRefusal('kivra', { send_state: 'active', provider_meta: {} }).details).toEqual({ state: 'off' })
  })
})

describe('sendingStateOf', () => {
  it('reads active before any access request, the request otherwise, and off without either', () => {
    expect(sendingStateOf({ send_state: 'active', send_request: 'pending' })).toBe('active')
    expect(sendingStateOf({ send_state: 'off', send_request: 'pending' })).toBe('pending')
    expect(sendingStateOf({ send_state: 'off', send_request: 'rejected' })).toBe('rejected')
    expect(sendingStateOf({ send_state: 'ended', send_request: null })).toBe('off')
    expect(sendingStateOf(null)).toBe('off')
  })
})
