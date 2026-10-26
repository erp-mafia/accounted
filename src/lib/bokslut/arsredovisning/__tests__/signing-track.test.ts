import { describe, expect, it } from 'vitest'
import type { SigningRequestView } from '@/lib/signing/requests'
import { createdSignerForSlot, deriveArsredovisningSigningTrack, expiredBlockingRequests } from '../signing-track'

const VERSION = 'v1'

function slot(id: string, status: 'pending' | 'signed' | 'declined', signing_method: 'paper_original' | 'advanced_e_signature' | 'bankid' | null = null) {
  return { id, status, signing_method, annual_report_version_id: VERSION }
}

function request(id: string, state: SigningRequestView['state']): SigningRequestView {
  return { signing_request_id: id, state, annual_report_version_id: VERSION, signers: [] } as unknown as SigningRequestView
}

describe('deriveArsredovisningSigningTrack', () => {
  it('is open either way while nothing is signed and nothing is open', () => {
    expect(deriveArsredovisningSigningTrack([slot('a', 'pending'), slot('b', 'pending')], [])).toEqual({ kind: 'none' })
    // A cancelled or expired request with no signatures leaves the choice open.
    expect(deriveArsredovisningSigningTrack([slot('a', 'pending')], [request('r1', 'cancelled'), request('r2', 'expired')])).toEqual({ kind: 'none' })
  })

  it('is BankID while a request is open, and once a BankID signature filled a slot', () => {
    const open = request('r1', 'open')
    expect(deriveArsredovisningSigningTrack([slot('a', 'pending')], [request('r0', 'cancelled'), open])).toEqual({ kind: 'bankid', open })
    expect(deriveArsredovisningSigningTrack([slot('a', 'signed', 'bankid'), slot('b', 'pending')], [request('r1', 'cancelled')])).toEqual({ kind: 'bankid', open: null })
  })

  it('is manual once any slot carries evidence recorded by hand, whatever is open', () => {
    expect(deriveArsredovisningSigningTrack([slot('a', 'signed', 'paper_original'), slot('b', 'pending')], [])).toEqual({ kind: 'manual' })
    expect(deriveArsredovisningSigningTrack([slot('a', 'signed', 'advanced_e_signature')], [request('r1', 'open')])).toEqual({ kind: 'manual' })
  })
})

describe('expiredBlockingRequests', () => {
  it('names the requests past their expiry that a new sending must cancel first', () => {
    expect(expiredBlockingRequests([request('r1', 'expired'), request('r2', 'cancelled'), request('r3', 'open')]).map((r) => r.signing_request_id)).toEqual(['r1'])
  })
})

describe('createdSignerForSlot', () => {
  const pending = [
    { id: 's1', signer_name: 'Anna Andersson' },
    { id: 's2', signer_name: 'Bo Berg' },
  ]
  const created = [
    { signer_id: 'x1', position: 1, name: 'Anna Andersson' },
    { signer_id: 'x2', position: 2, name: 'Bo Berg' },
  ]

  it('finds the signer by the slot\'s place among the pending slots', () => {
    expect(createdSignerForSlot(pending, created, 's2')?.signer_id).toBe('x2')
  })

  it('answers nothing for an unknown slot, or when the names disagree', () => {
    expect(createdSignerForSlot(pending, created, 'nope')).toBeNull()
    expect(createdSignerForSlot(pending, [{ signer_id: 'x1', position: 1, name: 'Someone Else' }], 's1')).toBeNull()
  })
})
