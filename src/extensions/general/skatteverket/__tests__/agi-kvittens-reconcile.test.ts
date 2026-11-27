/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const { warnRecorder, errorRecorder } = vi.hoisted(() => ({ warnRecorder: vi.fn(), errorRecorder: vi.fn() }))

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: warnRecorder,
    error: errorRecorder,
    child() {
      return this
    },
  }),
}))

vi.mock('../lib/agi-client', () => ({
  agiGetKvittenser: vi.fn(),
}))

vi.mock('../lib/resolve-auth', () => ({
  resolveUserReadAuth: vi.fn(),
}))

vi.mock('../lib/kvittens-notification', () => ({
  sendKvittensNotification: vi.fn().mockResolvedValue(undefined),
}))

vi.mock('@/lib/deadlines/complete-tax-deadline', () => ({
  completeTaxDeadline: vi.fn().mockResolvedValue(undefined),
}))

import {
  declarationKvittens,
  filedRunIds,
  newestAgiKvittens,
  reconcileAgiDeclaration,
  promoteAgiDeclaration,
} from '../lib/agi-kvittens-reconcile'
import { SkatteverketAuthError } from '../lib/api-client'
import { agiGetKvittenser } from '../lib/agi-client'
import { resolveUserReadAuth } from '../lib/resolve-auth'
import { sendKvittensNotification } from '../lib/kvittens-notification'
import { completeTaxDeadline } from '@/lib/deadlines/complete-tax-deadline'

const mockAgiGetKvittenser = vi.mocked(agiGetKvittenser)
const mockResolveUserReadAuth = vi.mocked(resolveUserReadAuth)
const mockSendKvittensNotification = vi.mocked(sendKvittensNotification)
const mockCompleteTaxDeadline = vi.mocked(completeTaxDeadline)

const DECL = {
  id: 'decl-1',
  company_id: 'comp-1',
  salary_run_id: 'run-1',
  period_year: 2026,
  period_month: 5,
}

/**
 * Table-aware stub covering the reconciler's four query shapes:
 * company_settings select (.single), the agi_declarations claim update
 * (awaited), the salary_runs update (awaited), and the extension_data
 * delete (awaited). Records which tables were mutated so the "no side
 * effects" assertions are structural, not inferred.
 */
function makeSupabase(opts: {
  claim?: { data?: unknown[] | null; error?: { message: string } | null }
  salaryRunError?: { message: string } | null
  historyError?: { message: string } | null
  /** The declaration's run (declarationKvittens reads its payroll month); absent reads as no row. */
  run?: { period_year: number; period_month: number } | null
  runReadError?: { message: string } | null
  /** Other runs of that month already filed (their agi_submitted_at). */
  filedRuns?: Array<{ agi_submitted_at: string }>
} = {}) {
  const mutatedTables: string[] = []
  const claimStatuses: unknown[] = []
  const recorded: Array<{ rows: unknown[]; options: unknown }> = []
  const updates: Array<{ table: string; values: any }> = []
  const stampedIds: unknown[] = []
  return {
    claimStatuses,
    recorded,
    updates,
    stampedIds,
    supabase: {
      from(table: string) {
        let op: 'read' | 'mutate' = 'read'
        const chain: any = {}
        for (const method of ['select', 'eq', 'neq', 'not', 'order', 'limit']) {
          chain[method] = vi.fn(() => chain)
        }
        chain.maybeSingle = vi.fn(async () => ({
          data: table === 'salary_runs' ? opts.run ?? null : null,
          error: table === 'salary_runs' ? opts.runReadError ?? null : null,
        }))
        chain.in = vi.fn((column: string, values: unknown) => {
          if (table === 'agi_declarations' && column === 'status') claimStatuses.push(values)
          if (table === 'salary_runs' && column === 'id') stampedIds.push(values)
          return chain
        })
        chain.update = vi.fn((values: unknown) => {
          op = 'mutate'
          updates.push({ table, values })
          return chain
        })
        chain.delete = vi.fn(() => {
          op = 'mutate'
          return chain
        })
        chain.upsert = vi.fn((rows: unknown[], options: unknown) => {
          op = 'mutate'
          recorded.push({ rows, options })
          return chain
        })
        chain.single = vi.fn(async () => ({
          data:
            table === 'company_settings'
              ? { org_number: '556123-4567', entity_type: 'aktiebolag' }
              : null,
          error: null,
        }))
        if (table === 'company_settings') chain.maybeSingle = chain.single
        chain.then = (resolve: (v: unknown) => void) => {
          if (op === 'mutate') mutatedTables.push(table)
          if (table === 'agi_declarations' && op === 'mutate') {
            return resolve({
              data: opts.claim && 'data' in opts.claim ? opts.claim.data : [{ id: DECL.id }],
              error: opts.claim?.error ?? null,
            })
          }
          if (table === 'salary_runs' && op === 'read') {
            return resolve({ data: opts.filedRuns ?? [], error: null })
          }
          if (table === 'salary_runs') {
            return resolve({ error: opts.salaryRunError ?? null })
          }
          if (table === 'agi_kvittenser') {
            return resolve({ data: null, error: opts.historyError ?? null })
          }
          return resolve({ data: null, error: null })
        }
        return chain
      },
    } as any,
    mutatedTables,
  }
}

function kvittensResponse() {
  return {
    ok: true,
    status: 200,
    data: {
      kvittenser: [
        {
          uuidKvittens: 'uuid-1',
          signeradAv: '191212121212',
          signeradTid: '2026-06-01T10:00:00Z',
        },
      ],
    },
  } as any
}

describe('reconcileAgiDeclaration: claim semantics', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // The fixture kvittens is signed 2026-06-01T10:00Z; observe it the next
    // morning so it is a fresh receipt (the stale case has its own tests).
    vi.useFakeTimers({ now: new Date('2026-06-02T08:00:00Z'), toFake: ['Date'] })
    mockResolveUserReadAuth.mockResolvedValue({
      ok: true,
      auth: { mode: 'user' } as any,
      source: 'user',
      tokenUserId: 'user-1',
    })
    mockAgiGetKvittenser.mockResolvedValue(kvittensResponse())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('promotes the declaration and runs all side effects on a successful claim', async () => {
    const { supabase, mutatedTables, claimStatuses } = makeSupabase()

    const outcome = await reconcileAgiDeclaration(supabase, DECL, { reconciledBy: 'cron' })

    expect(outcome).toEqual({ status: 'signed', kvittensnummer: 'uuid-1' })
    expect(mutatedTables).toEqual(['agi_kvittenser', 'agi_declarations', 'salary_runs', 'extension_data'])
    // Background runs only ever claim a declaration that is awaiting signature.
    expect(claimStatuses).toEqual([['pending_signature']])
    expect(mockCompleteTaxDeadline).toHaveBeenCalledTimes(1)
    expect(mockSendKvittensNotification).toHaveBeenCalledTimes(1)
  })

  it('returns already_claimed and runs no side effects when another run won the claim', async () => {
    const { supabase, mutatedTables } = makeSupabase({ claim: { data: [] } })

    const outcome = await reconcileAgiDeclaration(supabase, DECL, { reconciledBy: 'post-connect' })

    expect(outcome).toEqual({ status: 'already_claimed' })
    // The receipt is kept; past that, only the claim attempt mutated anything.
    expect(mutatedTables).toEqual(['agi_kvittenser', 'agi_declarations'])
    expect(mockCompleteTaxDeadline).not.toHaveBeenCalled()
    expect(mockSendKvittensNotification).not.toHaveBeenCalled()
  })

  it('returns error and runs no side effects when the claim update fails', async () => {
    const { supabase, mutatedTables } = makeSupabase({
      claim: { data: null, error: { message: 'connection reset' } },
    })

    const outcome = await reconcileAgiDeclaration(supabase, DECL, { reconciledBy: 'cron' })

    expect(outcome).toMatchObject({ status: 'error' })
    expect((outcome as { error: string }).error).toContain('connection reset')
    expect(mutatedTables).toEqual(['agi_kvittenser', 'agi_declarations'])
    expect(mockCompleteTaxDeadline).not.toHaveBeenCalled()
    expect(mockSendKvittensNotification).not.toHaveBeenCalled()
  })

  it('still reports signed and continues when the salary_runs stamp fails', async () => {
    const { supabase } = makeSupabase({ salaryRunError: { message: 'row locked' } })

    const outcome = await reconcileAgiDeclaration(supabase, DECL, { reconciledBy: 'cron' })

    expect(outcome).toEqual({ status: 'signed', kvittensnummer: 'uuid-1' })
    expect(mockCompleteTaxDeadline).toHaveBeenCalledTimes(1)
    expect(mockSendKvittensNotification).toHaveBeenCalledTimes(1)
    // Nothing revisits a submitted declaration: the missing stamp is an error (accounted#115).
    const errored = errorRecorder.mock.calls.map(c => String(c[0]))
    expect(errored.some(m => m.includes('agi_submitted_at stamp failed'))).toBe(true)
  })

  it('keeps every receipt Skatteverket lists for the period before claiming, keyed for idempotent re-reads', async () => {
    const original = { uuidKvittens: 'uuid-0', signeradAv: '191212121212', signeradTid: '2026-05-12T09:00:00Z' }
    mockAgiGetKvittenser.mockResolvedValueOnce({
      ok: true,
      status: 200,
      data: { kvittenser: [kvittensResponse().data.kvittenser[0], original, original] },
    } as any)
    const { supabase, recorded } = makeSupabase()

    const outcome = await reconcileAgiDeclaration(supabase, DECL, { reconciledBy: 'cron' })

    expect(outcome).toEqual({ status: 'signed', kvittensnummer: 'uuid-1' })
    expect(recorded).toHaveLength(1)
    expect(recorded[0].options).toEqual({ onConflict: 'company_id,uuid_kvittens', ignoreDuplicates: true })
    expect(recorded[0].rows).toEqual([
      expect.objectContaining({ company_id: DECL.company_id, uuid_kvittens: 'uuid-1', recorded_by: 'cron' }),
      expect.objectContaining({ uuid_kvittens: 'uuid-0', signerad_tid: '2026-05-12T09:00:00Z', receipt: original }),
    ])
  })

  it('leaves the declaration pending, untouched, when the receipts could not be kept', async () => {
    const { supabase, mutatedTables } = makeSupabase({ historyError: { message: 'connection reset' } })

    const outcome = await reconcileAgiDeclaration(supabase, DECL, { reconciledBy: 'cron' })

    expect(outcome).toMatchObject({ status: 'error' })
    expect((outcome as { error: string }).error).toContain('connection reset')
    expect(mutatedTables).toEqual(['agi_kvittenser'])
    expect(mockCompleteTaxDeadline).not.toHaveBeenCalled()
    expect(mockSendKvittensNotification).not.toHaveBeenCalled()
  })

  it('returns still_pending without attempting a claim when no kvittens exists', async () => {
    mockAgiGetKvittenser.mockResolvedValue({
      ok: true,
      status: 200,
      data: { kvittenser: [] },
    } as any)
    const { supabase, mutatedTables } = makeSupabase()

    const outcome = await reconcileAgiDeclaration(supabase, DECL, { reconciledBy: 'cron' })

    expect(outcome).toEqual({ status: 'still_pending' })
    expect(mutatedTables).toEqual([])
  })

  // The production state since July (#973, #2226): Skatteverket's gateway
  // refuses the APIGW client for the hantera API before it reads any bearer.
  it('returns gateway_refused, without touching anything, when the gateway refuses the APIGW client', async () => {
    mockAgiGetKvittenser.mockRejectedValue(
      new SkatteverketAuthError('Skatteverkets API-gateway nekade anropet.', 'ACCESS_DENIED', 'APIGW_CLIENT_REFUSED'),
    )
    const { supabase, mutatedTables } = makeSupabase()

    const outcome = await reconcileAgiDeclaration(supabase, DECL, { reconciledBy: 'cron' })

    expect(outcome).toEqual({ status: 'gateway_refused', route: 'direct', asked: true })
    expect(mutatedTables).toEqual([])
    expect(mockCompleteTaxDeadline).not.toHaveBeenCalled()
    expect(mockSendKvittensNotification).not.toHaveBeenCalled()
  })

  it('does not ask again for a route the caller has already seen refused', async () => {
    const { supabase, mutatedTables } = makeSupabase()

    const outcome = await reconcileAgiDeclaration(supabase, DECL, {
      reconciledBy: 'cron',
      refusedRoutes: new Set(['direct'] as const),
    })

    expect(outcome).toEqual({ status: 'gateway_refused', route: 'direct', asked: false })
    expect(mockAgiGetKvittenser).not.toHaveBeenCalled()
    expect(mutatedTables).toEqual([])
  })

  it('still asks when only the OTHER route was refused', async () => {
    const { supabase } = makeSupabase()

    const outcome = await reconcileAgiDeclaration(supabase, DECL, {
      reconciledBy: 'cron',
      refusedRoutes: new Set(['connector'] as const),
    })

    expect(outcome).toEqual({ status: 'signed', kvittensnummer: 'uuid-1' })
    expect(mockAgiGetKvittenser).toHaveBeenCalledTimes(1)
  })

  it('still propagates every other auth error to the caller (the cron owns those side effects)', async () => {
    for (const err of [
      new SkatteverketAuthError('Sessionen har gått ut.', 'SESSION_EXPIRED'),
      new SkatteverketAuthError('Åtkomst nekad av Skatteverket (403).', 'ACCESS_DENIED'),
    ]) {
      mockAgiGetKvittenser.mockRejectedValueOnce(err)
      const { supabase } = makeSupabase()
      await expect(
        reconcileAgiDeclaration(supabase, DECL, { reconciledBy: 'cron' }),
      ).rejects.toBe(err)
    }
  })
})

describe('late kvittens: recorded in full, announced only while it is news', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mockResolveUserReadAuth.mockResolvedValue({
      ok: true,
      auth: { mode: 'user' } as any,
      source: 'user',
      tokenUserId: 'user-1',
    })
    mockAgiGetKvittenser.mockResolvedValue(kvittensResponse())
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('a filing signed in June and first observed in September heals completely but sends no email', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-21T14:30:00Z'), toFake: ['Date'] })
    const { supabase, mutatedTables } = makeSupabase()

    const outcome = await reconcileAgiDeclaration(supabase, DECL, { reconciledBy: 'post-connect' })

    // Everything the books need: status + kvittens, salary run stamp, cache
    // cleanup and the period's AGI deadline confirmed, exactly once each.
    expect(outcome).toEqual({ status: 'signed', kvittensnummer: 'uuid-1' })
    expect(mutatedTables).toEqual(['agi_kvittenser', 'agi_declarations', 'salary_runs', 'extension_data'])
    expect(mockCompleteTaxDeadline).toHaveBeenCalledTimes(1)
    expect(mockCompleteTaxDeadline).toHaveBeenCalledWith(
      supabase, 'comp-1', ['arbetsgivardeklaration'], '2026-05', 'confirmed',
    )
    // "Din arbetsgivardeklaration har signerats" three months late is not a
    // confirmation, it is an alarm.
    expect(mockSendKvittensNotification).not.toHaveBeenCalled()
  })

  it('still notifies inside the week', async () => {
    vi.useFakeTimers({ now: new Date('2026-06-07T10:00:00Z'), toFake: ['Date'] })
    const { supabase } = makeSupabase()

    await reconcileAgiDeclaration(supabase, DECL, { reconciledBy: 'cron' })

    expect(mockSendKvittensNotification).toHaveBeenCalledTimes(1)
  })

  it('notifies when Skatteverket omits signeradTid: an unknown signing time is not a stale one', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-21T14:30:00Z'), toFake: ['Date'] })
    mockAgiGetKvittenser.mockResolvedValue({
      ok: true,
      status: 200,
      data: { kvittenser: [{ uuidKvittens: 'uuid-1', signeradAv: '191212121212' }] },
    } as any)
    const { supabase } = makeSupabase()

    await reconcileAgiDeclaration(supabase, DECL, { reconciledBy: 'cron' })

    expect(mockSendKvittensNotification).toHaveBeenCalledTimes(1)
  })

  it('a second observer of the same late kvittens runs no side effect again', async () => {
    vi.useFakeTimers({ now: new Date('2026-09-21T14:30:00Z'), toFake: ['Date'] })
    const first = makeSupabase()
    const second = makeSupabase({ claim: { data: [] } })

    await reconcileAgiDeclaration(first.supabase, DECL, { reconciledBy: 'post-connect' })
    const outcome = await reconcileAgiDeclaration(second.supabase, DECL, { reconciledBy: 'cron' })

    expect(outcome).toEqual({ status: 'already_claimed' })
    expect(second.mutatedTables).toEqual(['agi_kvittenser', 'agi_declarations'])
    expect(mockCompleteTaxDeadline).toHaveBeenCalledTimes(1)
  })
})

describe('promoteAgiDeclaration: the interactive check shares the claim', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ now: new Date('2026-06-01T10:05:00Z'), toFake: ['Date'] })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const kvittens = kvittensResponse().data.kvittenser[0]

  it('runs the filing side effects but sends no email when the user is the one looking', async () => {
    const { supabase, mutatedTables, claimStatuses } = makeSupabase()

    const outcome = await promoteAgiDeclaration(supabase, DECL, kvittens, {
      reconciledBy: 'interactive',
      submittedBy: 'user-9',
      notifyUserId: null,
      fromStatuses: ['pending_signature', 'generated', 'exported'],
    })

    expect(outcome).toEqual({ status: 'signed', kvittensnummer: 'uuid-1' })
    expect(mutatedTables).toEqual(['agi_declarations', 'salary_runs', 'extension_data'])
    expect(claimStatuses).toEqual([['pending_signature', 'generated', 'exported']])
    expect(mockCompleteTaxDeadline).toHaveBeenCalledTimes(1)
    expect(mockSendKvittensNotification).not.toHaveBeenCalled()
  })

  it('loses the claim quietly when the cron recorded the kvittens first', async () => {
    const { supabase, mutatedTables } = makeSupabase({ claim: { data: [] } })

    const outcome = await promoteAgiDeclaration(supabase, DECL, kvittens, {
      reconciledBy: 'interactive',
      submittedBy: 'user-9',
      notifyUserId: null,
    })

    expect(outcome).toEqual({ status: 'already_claimed' })
    expect(mutatedTables).toEqual(['agi_declarations'])
    expect(mockCompleteTaxDeadline).not.toHaveBeenCalled()
  })

  it("files every run a month's summed declaration covers", async () => {
    const { supabase, stampedIds, updates } = makeSupabase({
      claim: { data: [{ id: DECL.id, salary_run_ids: [DECL.salary_run_id, 'run-sibling'] }] },
    })

    const outcome = await promoteAgiDeclaration(supabase, DECL, kvittens, {
      reconciledBy: 'interactive',
      submittedBy: 'user-9',
      notifyUserId: null,
    })

    expect(outcome).toEqual({ status: 'signed', kvittensnummer: 'uuid-1' })
    expect(stampedIds).toEqual([[DECL.salary_run_id, 'run-sibling']])
    expect(updates.find((u) => u.table === 'salary_runs')?.values).toEqual({ agi_submitted_at: expect.any(String) })
  })

  it('refuses a kvittens without a number', async () => {
    const { supabase, mutatedTables } = makeSupabase()

    const outcome = await promoteAgiDeclaration(
      supabase,
      DECL,
      { ...kvittens, uuidKvittens: undefined },
      { reconciledBy: 'interactive', submittedBy: 'user-9', notifyUserId: null },
    )

    expect(outcome).toMatchObject({ status: 'error' })
    expect(mutatedTables).toEqual([])
  })
})

/**
 * A correction run's declaration (the period's row, taken over from the run it
 * corrects) is promoted on its OWN kvittens. Skatteverket lists every kvittens
 * of the redovisningsperiod, so until the correction is signed the list holds
 * only the original's, and that one must never be claimed for the correction.
 */
describe('declarationKvittens: a correction is promoted on its own kvittens', () => {
  // The original filing of May, stamped on the run it was filed for.
  const ORIGINAL = { uuidKvittens: 'k-original', signeradAv: '191212121212', signeradTid: '2026-06-10T09:00:00Z' }
  const CORRECTION = { uuidKvittens: 'k-correction', signeradAv: '191212121212', signeradTid: '2026-06-20T14:00:00Z' }
  const MAY = { period_year: 2026, period_month: 5 }
  const ORIGINAL_FILED = [{ agi_submitted_at: '2026-06-10T09:00:00+00:00' }]

  const listing = (...kvittenser: unknown[]) => ({ ok: true, status: 200, data: { kvittenser } }) as any

  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers({ now: new Date('2026-06-20T14:05:00Z'), toFake: ['Date'] })
    mockResolveUserReadAuth.mockResolvedValue({
      ok: true,
      auth: { mode: 'user' } as any,
      source: 'user',
      tokenUserId: 'user-1',
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps the correction pending while the period lists only the original\'s kvittens', async () => {
    mockAgiGetKvittenser.mockResolvedValueOnce(listing(ORIGINAL))
    const { supabase, mutatedTables, recorded } = makeSupabase({ run: MAY, filedRuns: ORIGINAL_FILED })

    const outcome = await reconcileAgiDeclaration(supabase, DECL, { reconciledBy: 'cron' })

    expect(outcome).toEqual({ status: 'still_pending' })
    // The receipt is kept, nothing else moves: no claim, no run stamp, no deadline.
    expect(recorded).toHaveLength(1)
    expect(mutatedTables).toEqual(['agi_kvittenser'])
    expect(mockCompleteTaxDeadline).not.toHaveBeenCalled()
    expect(mockSendKvittensNotification).not.toHaveBeenCalled()
  })

  it.each([
    ['oldest first', [ORIGINAL, CORRECTION]],
    ['newest first', [CORRECTION, ORIGINAL]],
  ])('promotes the correction on its own kvittens once signed (%s)', async (_order, kvittenser) => {
    mockAgiGetKvittenser.mockResolvedValueOnce(listing(...kvittenser))
    const { supabase, updates } = makeSupabase({ run: MAY, filedRuns: ORIGINAL_FILED })

    const outcome = await reconcileAgiDeclaration(supabase, DECL, { reconciledBy: 'cron' })

    expect(outcome).toEqual({ status: 'signed', kvittensnummer: 'k-correction' })
    expect(updates.find((u) => u.table === 'agi_declarations')?.values).toMatchObject({
      status: 'submitted',
      kvittensnummer: 'k-correction',
      submitted_at: CORRECTION.signeradTid,
    })
    // The correction run gets the correction's signing moment, never the original's.
    expect(updates.find((u) => u.table === 'salary_runs')?.values).toEqual({ agi_submitted_at: CORRECTION.signeradTid })
  })

  it('a month without another filing takes the newest kvittens whatever the list order', async () => {
    const older = { uuidKvittens: 'k-older', signeradTid: '2026-06-01T08:00:00Z' }
    const newer = { uuidKvittens: 'k-newer', signeradTid: '2026-06-02T08:00:00Z' }
    const { supabase } = makeSupabase({ run: MAY, filedRuns: [] })

    const own = await declarationKvittens(supabase, 'comp-1', 'run-1', [older, newer] as any)

    expect(own).toEqual({ ok: true, kvittens: newer })
  })

  it('answers an error, not still_pending, when the month\'s runs cannot be read', async () => {
    mockAgiGetKvittenser.mockResolvedValueOnce(listing(ORIGINAL, CORRECTION))
    const { supabase, mutatedTables } = makeSupabase({ runReadError: { message: 'connection reset' } })

    const outcome = await reconcileAgiDeclaration(supabase, DECL, { reconciledBy: 'cron' })

    expect(outcome).toMatchObject({ status: 'error' })
    expect((outcome as { error: string }).error).toContain('connection reset')
    expect(mutatedTables).toEqual(['agi_kvittenser'])
  })

  it('refuses a kvittens without a signing time when the month has an earlier filing', async () => {
    const { supabase } = makeSupabase({ run: MAY, filedRuns: ORIGINAL_FILED })

    const own = await declarationKvittens(supabase, 'comp-1', 'run-1', [{ uuidKvittens: 'k-untimed' }] as any)

    expect(own).toEqual({ ok: true, kvittens: null })
  })
})

describe('newestAgiKvittens', () => {
  it('picks the latest signing time, skips entries without a number, and falls back to list order', () => {
    const a = { uuidKvittens: 'a', signeradTid: '2026-06-01T08:00:00Z' }
    const b = { uuidKvittens: 'b', signeradTid: '2026-06-03T08:00:00Z' }
    const unnumbered = { signeradTid: '2026-06-09T08:00:00Z' }
    const untimed = { uuidKvittens: 'c' }

    expect(newestAgiKvittens([a, unnumbered, b] as any)).toBe(b)
    expect(newestAgiKvittens([untimed, a] as any)).toBe(a)
    expect(newestAgiKvittens([untimed, { uuidKvittens: 'd' }] as any)).toBe(untimed)
    expect(newestAgiKvittens([unnumbered] as any)).toBeNull()
    expect(newestAgiKvittens(undefined)).toBeNull()
  })
})

describe('filedRunIds', () => {
  it('is the holder alone for a one-run declaration, and every covered run of a summed month once', () => {
    expect(filedRunIds('run-a', null)).toEqual(['run-a'])
    expect(filedRunIds('run-a', ['run-a', 'run-b'])).toEqual(['run-a', 'run-b'])
    expect(filedRunIds(null, undefined)).toEqual([])
  })
})
