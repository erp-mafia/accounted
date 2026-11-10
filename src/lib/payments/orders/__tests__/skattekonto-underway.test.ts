import { describe, expect, it } from 'vitest'
import { UNANSWERED_SIGNING_MINUTES } from '../status'
import { isSkattekontoPaymentUnderway, skattekontoPaymentsCovering } from '../skattekonto-underway'

const FETCHED = Date.parse('2026-10-16T05:00:00Z')
const NOW = Date.parse('2026-10-16T10:00:00Z')
const minutesBefore = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString()

/** A signing nobody finished, started `minutes` before NOW. */
const openSigning = (minutes: number) => ({ status: 'awaiting_signature', signing_started_at: minutesBefore(minutes) })

describe('skattekontoPaymentsCovering', () => {
  it('counts orders on their way and executed ones the saldo cannot show yet, never a draft', () => {
    const orders = [
      { amount: '1000.10', status: 'approved', executed_at: null, signing: null },
      { amount: 200, status: 'awaiting_signature', executed_at: null, signing: openSigning(5) },
      { amount: 300, status: 'executed', executed_at: '2026-10-16T08:00:00Z', signing: null }, // after the fetch: counts
      { amount: 400, status: 'executed', executed_at: '2026-10-15T08:00:00Z', signing: null }, // before the fetch: already in the saldo
      { amount: 500, status: 'draft', executed_at: null, signing: null },
    ]
    expect(skattekontoPaymentsCovering(orders, FETCHED, NOW)).toBe(1500.1)
  })

  it('without a snapshot counts only the orders on their way', () => {
    const orders = [
      { amount: 100, status: 'accepted', executed_at: null, signing: null },
      { amount: 300, status: 'executed', executed_at: '2026-10-16T08:00:00Z', signing: null },
    ]
    expect(skattekontoPaymentsCovering(orders, null, NOW)).toBe(100)
    expect(skattekontoPaymentsCovering([], FETCHED, NOW)).toBe(0)
  })

  describe('a payment waiting for its BankID (crm#1721)', () => {
    const waiting = (signing: { status: string; signing_started_at: string | null } | null) => [
      { amount: 5000, status: 'awaiting_signature', executed_at: null, signing },
    ]

    it('counts while its signing can still finish', () => {
      expect(skattekontoPaymentsCovering(waiting(openSigning(1)), FETCHED, NOW)).toBe(5000)
      expect(skattekontoPaymentsCovering(waiting(openSigning(UNANSWERED_SIGNING_MINUTES - 1)), FETCHED, NOW)).toBe(5000)
    })

    it('stops counting once its signing started UNANSWERED_SIGNING_MINUTES ago, so the shortfall shows again', () => {
      expect(skattekontoPaymentsCovering(waiting(openSigning(UNANSWERED_SIGNING_MINUTES)), FETCHED, NOW)).toBe(0)
      // Eight days on, as the reported payment stood.
      expect(skattekontoPaymentsCovering(waiting(openSigning(8 * 24 * 60)), FETCHED, NOW)).toBe(0)
    })

    it('reads the signing the same whether the embed comes back as an object or a one-row array', () => {
      const asArray = [{ amount: 5000, status: 'awaiting_signature', executed_at: null, signing: [openSigning(1)] }]
      expect(skattekontoPaymentsCovering(asArray, FETCHED, NOW)).toBe(5000)
      const staleArray = [{ amount: 5000, status: 'awaiting_signature', executed_at: null, signing: [openSigning(UNANSWERED_SIGNING_MINUTES)] }]
      expect(skattekontoPaymentsCovering(staleArray, FETCHED, NOW)).toBe(0)
      expect(skattekontoPaymentsCovering([{ amount: 5000, status: 'awaiting_signature', executed_at: null, signing: [] }], FETCHED, NOW)).toBe(0)
    })

    it('counts nothing when no signing of it is known to have started', () => {
      expect(skattekontoPaymentsCovering(waiting(null), FETCHED, NOW)).toBe(0)
      expect(skattekontoPaymentsCovering(waiting({ status: 'awaiting_signature', signing_started_at: null }), FETCHED, NOW)).toBe(0)
      expect(skattekontoPaymentsCovering(waiting({ status: 'created', signing_started_at: 'not a date' }), FETCHED, NOW)).toBe(0)
    })

    it('lets a read that saw the signing finish win at any age: signed while the bank confirms it, or moved on', () => {
      const old = minutesBefore(8 * 24 * 60)
      // The BankID finalised and the bank still answers RCVD (isBankConfirming).
      expect(skattekontoPaymentsCovering(waiting({ status: 'signed', signing_started_at: old }), FETCHED, NOW)).toBe(5000)
      expect(skattekontoPaymentsCovering(waiting({ status: 'awaiting_second_signer', signing_started_at: old }), FETCHED, NOW)).toBe(5000)
      // A read moved the order on: its old signing no longer matters.
      const read = [
        { amount: 5000, status: 'accepted', executed_at: null, signing: openSigning(8 * 24 * 60) },
        { amount: 700, status: 'awaiting_second_signer', executed_at: null, signing: openSigning(8 * 24 * 60) },
        { amount: 300, status: 'executed', executed_at: '2026-10-16T08:00:00Z', signing: openSigning(8 * 24 * 60) },
      ]
      expect(skattekontoPaymentsCovering(read, FETCHED, NOW)).toBe(6000)
    })

    it('measures the window from the signing start alone: every later run whose read failed finds the same start and the same answer', () => {
      const order = { status: 'awaiting_signature', signing: openSigning(UNANSWERED_SIGNING_MINUTES - 10) }
      // A failed read writes nothing, so each run past the start sees this same row.
      const runs = [0, 5, 9, 10, 15, 60, 24 * 60].map((minutesLater) => isSkattekontoPaymentUnderway(order, NOW + minutesLater * 60_000))
      expect(runs).toEqual([true, true, true, false, false, false, false])
    })
  })
})
