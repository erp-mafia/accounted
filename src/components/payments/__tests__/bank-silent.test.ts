import { describe, expect, it } from 'vitest'
import sv from '@/messages/sv.json'
import en from '@/messages/en.json'
import { BANK_SILENT_AFTER_MS, bankSilentSince } from '../payment-order-status'
import { SCHEDULED_PAYMENT_READ_EVERY_MS, type PaymentOrderStatus } from '@/lib/payments/orders/status'

const NOW = Date.parse('2026-11-07T08:00:00Z')
const row = (status: PaymentOrderStatus, provider_status_at: string | null, outcome_unknown_at: string | null = null) => ({
  status,
  provider_status_at,
  outcome_unknown_at,
})

describe('a payment the bank has not answered about for a day says so on its Betalningar row', () => {
  it('never calls a planned payment silent between two of its reads: the sync asks about it at least three times inside the day', () => {
    expect(SCHEDULED_PAYMENT_READ_EVERY_MS * 3).toBeLessThanOrEqual(BANK_SILENT_AFTER_MS)
  })

  it('names the last answer of a payment the bank still holds, once it is more than a day old', () => {
    // Production, 2026-10-30: a status read refused every 15 minutes for a week.
    const lastAnswer = '2026-10-30T01:31:56.463Z'
    for (const status of ['submitted', 'awaiting_signature', 'awaiting_second_signer', 'accepted'] as const) {
      expect(bankSilentSince(row(status, lastAnswer), NOW)).toBe(lastAnswer)
    }
  })

  it('says nothing while the bank answers: every status read moves provider_status_at', () => {
    expect(bankSilentSince(row('accepted', new Date(NOW - 15 * 60_000).toISOString()), NOW)).toBeNull()
    expect(bankSilentSince(row('accepted', new Date(NOW - BANK_SILENT_AFTER_MS).toISOString()), NOW)).toBeNull()
  })

  it('says nothing for an order the bank does not hold, one whose outcome is unknown (it has its own line), or one never read', () => {
    const old = '2026-10-01T00:00:00Z'
    for (const status of ['draft', 'approved', 'executed', 'rejected', 'cancelled', 'failed'] as const) {
      expect(bankSilentSince(row(status, old), NOW)).toBeNull()
    }
    expect(bankSilentSince(row('submitted', old, '2026-10-01T00:20:00Z'), NOW)).toBeNull()
    expect(bankSilentSince(row('submitted', null), NOW)).toBeNull()
    expect(bankSilentSince(row('accepted', 'not a date'), NOW)).toBeNull()
  })

  it('has its line in both languages', () => {
    expect(sv.bank_payments.bank_silent_since).toContain('{date}')
    expect(en.bank_payments.bank_silent_since).toContain('{date}')
  })
})
