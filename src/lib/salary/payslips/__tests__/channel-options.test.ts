import { describe, it, expect } from 'vitest'
import {
  payslipChannelOptions,
  payslipSendRequest,
  resolvePayslipChannel,
} from '@/lib/salary/payslips/channel-options'

describe('payslipChannelOptions', () => {
  it('is the email link alone when no mailbox sends', () => {
    expect(payslipChannelOptions([])).toEqual(['email'])
  })

  it('lists email first, then Billo before Kivra, whatever order they arrive in', () => {
    expect(payslipChannelOptions(['kivra', 'billo'])).toEqual(['email', 'billo', 'kivra'])
    expect(payslipChannelOptions(['kivra'])).toEqual(['email', 'kivra'])
    expect(payslipChannelOptions(['billo'])).toEqual(['email', 'billo'])
  })
})

describe('resolvePayslipChannel', () => {
  it('keeps an offered pick', () => {
    expect(resolvePayslipChannel('billo', ['email', 'billo'])).toBe('billo')
  })

  it('falls back to the email link without a pick or when the pick is no longer offered', () => {
    expect(resolvePayslipChannel(null, ['email', 'billo'])).toBe('email')
    expect(resolvePayslipChannel('kivra', ['email', 'billo'])).toBe('email')
  })
})

describe('payslipSendRequest', () => {
  it('posts no body for the email link, as before the mailbox channels', () => {
    expect(payslipSendRequest('email')).toEqual({ method: 'POST' })
  })

  it('posts the mailbox channel', () => {
    for (const channel of ['kivra', 'billo'] as const) {
      const init = payslipSendRequest(channel)
      expect(init.method).toBe('POST')
      expect(init.headers).toEqual({ 'Content-Type': 'application/json' })
      expect(JSON.parse(init.body as string)).toEqual({ channel })
    }
  })
})
