import { describe, expect, it } from 'vitest'
import { signingFinished } from '../BankIdSigningFlow'
import type { SigningView } from '../payments-client'

const view = (status: SigningView['status'], failure_code: string | null, sign_anew: string[] = []): SigningView => ({
  batch_id: 'batch-1',
  status,
  challenge: null,
  failure_code,
  step: null,
  follow_up: false,
  sign_anew,
  orders: [],
})

describe('where the signing flow goes after a poll (crm#1470)', () => {
  it('stays on the signing step, to sign anew, when the BankID ended unsigned and the server let the orders go', () => {
    expect(signingFinished(view('failed', 'SIGNING_SESSION_EXPIRED', ['o1']))).toBe(false)
  })

  it('shows the result when nothing is offered to sign anew', () => {
    expect(signingFinished(view('failed', 'PSU_RIGHTS_MISSING'))).toBe(true)
    expect(signingFinished(view('signed', null))).toBe(true)
  })
})
