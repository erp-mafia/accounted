import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CASH_ACCOUNT_BUSY_RETRY, isCashAccountBusy, retryWhileCashAccountBusy } from '../cash-account-busy'
import { BookkeepingDatabaseError } from '../errors'

type Outcome = { error: unknown; data?: unknown }

const realDelays = CASH_ACCOUNT_BUSY_RETRY.delaysMs

beforeEach(() => {
  CASH_ACCOUNT_BUSY_RETRY.delaysMs = [0, 0, 0, 0]
})
afterEach(() => {
  CASH_ACCOUNT_BUSY_RETRY.delaysMs = realDelays
})

describe('isCashAccountBusy', () => {
  it('reads the PostgREST refusal the guards raise', () => {
    expect(isCashAccountBusy({ code: 'PT409', message: 'CASH_ACCOUNT_OPERATION_BUSY', details: null, hint: null })).toBe(true)
  })

  it('reads the engine wrapping of the same refusal', () => {
    expect(isCashAccountBusy(new BookkeepingDatabaseError('create_reversal_lines', 'CASH_ACCOUNT_OPERATION_BUSY', 'PT409'))).toBe(true)
  })

  it('is false for other refusals and for nothing', () => {
    expect(isCashAccountBusy({ code: 'PT409', message: 'BANK_ANCHOR_SETTLEMENT_CHANGED' })).toBe(false)
    expect(isCashAccountBusy(new Error('network'))).toBe(false)
    expect(isCashAccountBusy(null)).toBe(false)
    expect(isCashAccountBusy(undefined)).toBe(false)
  })
})

describe('retryWhileCashAccountBusy', () => {
  it('returns the first outcome that is not busy', async () => {
    const attempt = vi.fn<() => Promise<Outcome>>()
      .mockResolvedValueOnce({ error: { message: 'CASH_ACCOUNT_OPERATION_BUSY' } })
      .mockResolvedValueOnce({ error: null, data: [1] })
    const outcome = await retryWhileCashAccountBusy(attempt, (o) => isCashAccountBusy(o.error))
    expect(outcome).toEqual({ error: null, data: [1] })
    expect(attempt).toHaveBeenCalledTimes(2)
  })

  it('does not retry an outcome that was never busy', async () => {
    const attempt = vi.fn<() => Promise<Outcome>>().mockResolvedValue({ error: { message: 'Update failed' } })
    await retryWhileCashAccountBusy(attempt, (o) => isCashAccountBusy(o.error))
    expect(attempt).toHaveBeenCalledTimes(1)
  })

  it('gives up after the configured waits with the last outcome', async () => {
    const attempt = vi.fn<() => Promise<Outcome>>().mockResolvedValue({ error: { message: 'CASH_ACCOUNT_OPERATION_BUSY' } })
    const outcome = await retryWhileCashAccountBusy(attempt, (o) => isCashAccountBusy(o.error))
    expect(isCashAccountBusy(outcome.error)).toBe(true)
    // The first try plus one per configured wait.
    expect(attempt).toHaveBeenCalledTimes(5)
  })
})
