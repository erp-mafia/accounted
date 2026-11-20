import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'

const log = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn() }))
vi.mock('@/lib/logger', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/logger')>()
  const logger = { debug: vi.fn(), info: vi.fn(), warn: log.warn, error: log.error, child: (): unknown => logger }
  return { ...actual, createLogger: () => logger }
})
vi.mock('@/lib/providers/resolve-consent', () => ({ resolveConsent: vi.fn() }))

import { runBokioSupplierCompletion } from '../lib/complete-bokio-supplier-invoices'

/**
 * The unattended Bokio pass takes the ten companies whose next_attempt_at is
 * oldest. A company whose claim itself failed was never released, so it kept
 * the next_attempt_at it was selected by and its place at the head of the
 * queue, on every run, with a warning that named no error.
 */
const NOW = new Date('2026-11-12T08:00:00.000Z')

const queue = (claim: { data?: unknown; error?: { code: string; message: string } }) =>
  createTableMockSupabase({
    bokio_supplier_completion_work: { data: [{ company_id: 'company-1', consent_id: 'consent-1' }] },
    'rpc:claim_bokio_supplier_completion': claim,
  })

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] })
})

describe('runBokioSupplierCompletion: a company whose claim fails', () => {
  it('waits an hour behind the others when the claim could not be made, and the warning names why', async () => {
    const mock = queue({ error: { code: '08006', message: 'connection failure' } })

    const results = await runBokioSupplierCompletion(mock.supabase as unknown as SupabaseClient, NOW.getTime() + 60_000)

    expect(results).toEqual([{ failed: 1, partial: true }])
    expect(mock.payloads('bokio_supplier_completion_work', 'update')).toEqual([
      { next_attempt_at: new Date(NOW.getTime() + 3_600_000).toISOString() },
    ])
    // Only a row no run holds and nothing has moved since it was selected:
    // a run that got its claim was released a minute ahead and is left alone.
    expect(mock.findCalls('bokio_supplier_completion_work', 'is')).toContainEqual(['run_id', null])
    expect(mock.findCalls('bokio_supplier_completion_work', 'lte')).toEqual([
      ['next_attempt_at', NOW.toISOString()],
      ['next_attempt_at', NOW.toISOString()],
    ])
    expect(log.warn).toHaveBeenCalledWith('enrolled company completion deferred',
      { companyId: 'company-1', reason: 'claim_bokio_supplier_completion: 08006' })
    expect(log.error).not.toHaveBeenCalled()
  })

  it('is parked, and reported once as an error, when the claim was refused: its connection is gone', async () => {
    const mock = queue({ error: { code: 'P0001', message: 'BOKIO_CONSENT_NOT_FOUND' } })

    await runBokioSupplierCompletion(mock.supabase as unknown as SupabaseClient, NOW.getTime() + 60_000)

    expect(mock.payloads('bokio_supplier_completion_work', 'update')).toEqual([{ next_attempt_at: 'infinity' }])
    expect(log.error).toHaveBeenCalledTimes(1)
    expect(log.error).toHaveBeenCalledWith(
      'Bokio supplier completion parked: its connection is gone or names another account', undefined,
      { companyId: 'company-1', consentId: 'consent-1', reason: 'claim_bokio_supplier_completion: P0001' })
  })

  it('throws a queue read failure with the database code on it', async () => {
    const { supabase } = createTableMockSupabase({
      bokio_supplier_completion_work: { error: { code: '42501', message: 'permission denied' } },
    })
    await expect(runBokioSupplierCompletion(supabase as unknown as SupabaseClient, NOW.getTime() + 60_000))
      .rejects.toMatchObject({ message: 'BOKIO_COMPLETION_QUEUE_READ_FAILED', code: '42501' })
  })
})
