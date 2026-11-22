/**
 * A voucher chunk refused by journal_import_source_owned_idx, because one of
 * its vouchers has the source series and number of another verifikat of its
 * fiscal year, is refused the same way on every try
 * (tests/pg/sie-job-stop-taken-source-voucher.pg.test.ts). The worker handed
 * it to record_sie_job_failure, which claimed the job again for up to 32
 * failures and then showed a technical error (2026-11-16). It now stops the
 * job at once with a sentence that names the voucher.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'

vi.mock('@/lib/auth/api-keys', () => ({ createServiceClientNoCookies: vi.fn() }))

import { SIESourceVoucherTakenError, sieSourceVoucherTaken, BookkeepingDatabaseError } from '@/lib/bookkeeping/errors'
import { runSIEWorker, takenSourceVoucherReason } from '../sie-job-worker'

const INDEX_REFUSAL = {
  code: '23505',
  message: 'duplicate key value violates unique constraint "journal_import_source_owned_idx"',
  details: 'Key (company_id, fiscal_period_id, source_voucher_series, source_voucher_number)=(11111111-1111-4111-8111-111111111111, 22222222-2222-4222-8222-222222222222, A, 762) already exists.',
  hint: null,
}

const job = {
  id: 'import-1',
  company_id: 'company-1',
  fiscal_period_id: 'period-1',
  worker_id: 'worker-1',
  job_attempt: 3,
  job_state: 'running',
  job_phase: 'vouchers',
  job_kind: 'import',
  chunks_done: 4,
  chunks_total: 9,
  consecutive_failures: 0,
  manifest: {},
}

function client(answers: Record<string, { data?: unknown; error?: Record<string, unknown> | null }>) {
  const rpc = vi.fn(async (name: string, _args?: Record<string, unknown>) => ({ data: null, error: null, ...answers[name] }))
  return { supabase: { rpc } as unknown as SupabaseClient, rpc }
}

const calledWith = (rpc: ReturnType<typeof client>['rpc'], name: string) =>
  rpc.mock.calls.filter(([called]) => called === name).map(([, args]) => args)

describe('sieSourceVoucherTaken', () => {
  it('reads the voucher from the unique violation of journal_import_source_owned_idx', () => {
    const taken = sieSourceVoucherTaken(INDEX_REFUSAL)
    expect(taken).toBeInstanceOf(SIESourceVoucherTakenError)
    // Still a database error to every reader that knew it as one.
    expect(taken).toBeInstanceOf(BookkeepingDatabaseError)
    expect(taken?.voucherRef).toBe('A762')
    expect(taken?.message).toBe('Database operation "import_sie_chunk" failed: duplicate key value violates unique constraint "journal_import_source_owned_idx"')
  })

  it('names no voucher when the detail is missing', () => {
    expect(sieSourceVoucherTaken({ ...INDEX_REFUSAL, details: null })?.voucherRef).toBeNull()
  })

  it('is no answer for any other failure', () => {
    expect(sieSourceVoucherTaken({ code: '23505', message: 'duplicate key value violates unique constraint "journal_import_batch_ordinal_idx"' })).toBeNull()
    // import_sie_chunk's own check also covers a changed voucher of the job itself: not this refusal.
    expect(sieSourceVoucherTaken({ code: '23505', message: 'SIE conflicting voucher A762' })).toBeNull()
    expect(sieSourceVoucherTaken({ code: '57014', message: 'canceling statement due to statement timeout' })).toBeNull()
    expect(sieSourceVoucherTaken({ code: '55P03', message: 'SIE platform write capacity is busy' })).toBeNull()
  })
})

describe('runSIEWorker on a voucher chunk', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    delete process.env.SIE_IMPORT_WORKER_PAUSED
  })

  it('stops the job at once, naming the voucher, when its source series and number are taken', async () => {
    const { supabase, rpc } = client({
      claim_sie_import_job: { data: job },
      import_sie_chunk: { error: INDEX_REFUSAL },
      stop_sie_import_job: { data: 'paused' },
    })

    expect(await runSIEWorker({ supabase, importId: 'import-1' })).toEqual({ jobs: 1, chunks: 0 })

    expect(calledWith(rpc, 'stop_sie_import_job')).toEqual([{
      p_company_id: 'company-1', p_import_id: 'import-1', p_worker_id: 'worker-1', p_attempt: 3,
      p_reason: 'Verifikation A762 har samma serie och nummer som en annan verifikation i räkenskapsåret, i filen eller redan bokförd. Två verifikationer kan inte ha samma serie och nummer i ett räkenskapsår, så importen har stoppats.',
    }])
    // Never retried as if it might pass.
    expect(calledWith(rpc, 'record_sie_job_failure')).toEqual([])
  })

  it('still records any other failure for a retry, as before', async () => {
    const { supabase, rpc } = client({
      claim_sie_import_job: { data: job },
      import_sie_chunk: { error: { code: '57014', message: 'canceling statement due to statement timeout' } },
    })

    await runSIEWorker({ supabase, importId: 'import-1' })

    expect(calledWith(rpc, 'record_sie_job_failure')).toEqual([expect.objectContaining({
      p_error: 'Database operation "import_sie_chunk" failed: canceling statement due to statement timeout',
    })])
    expect(calledWith(rpc, 'stop_sie_import_job')).toEqual([])
  })

  it.each(['PGRST202', '42883'])('records the failure as before while the stop function is not installed (%s)', async (code) => {
    const { supabase, rpc } = client({
      claim_sie_import_job: { data: job },
      import_sie_chunk: { error: INDEX_REFUSAL },
      stop_sie_import_job: { error: { code, message: 'Could not find the function public.stop_sie_import_job' } },
    })

    await runSIEWorker({ supabase, importId: 'import-1' })

    expect(calledWith(rpc, 'record_sie_job_failure')).toEqual([expect.objectContaining({
      p_error: 'Database operation "import_sie_chunk" failed: duplicate key value violates unique constraint "journal_import_source_owned_idx"',
    })])
  })
})

describe('takenSourceVoucherReason', () => {
  it('reads as a sentence for the person, never as the database error', () => {
    expect(takenSourceVoucherReason(new SIESourceVoucherTakenError('x', null)))
      .toBe('En verifikation har samma serie och nummer som en annan verifikation i räkenskapsåret, i filen eller redan bokförd. Två verifikationer kan inte ha samma serie och nummer i ett räkenskapsår, så importen har stoppats.')
  })
})
