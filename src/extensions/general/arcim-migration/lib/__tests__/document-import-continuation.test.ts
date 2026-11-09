import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import { createTableMockSupabase } from '@/tests/helpers'
import { ExecutionBudgetExceeded } from '@/lib/http/execution-budget'

vi.mock('../import-documents', () => {
  class FortnoxDocumentScopesRequiredError extends Error {
    readonly code = 'PROVIDER_DOCUMENT_SCOPES_REQUIRED'
  }
  class ProviderConnectionRefusedError extends Error {
    constructor(
      readonly provider: string,
      readonly code: 'PROVIDER_AUTH_EXPIRED' | 'PROVIDER_RESOURCE_FORBIDDEN',
      readonly providerStatus: number,
    ) {
      super(`${provider} refused the connection (${providerStatus}): reconnect required`)
    }
  }
  class ProviderCallError extends Error {
    constructor(readonly code: string) {
      super(code)
    }
  }
  return { FortnoxDocumentScopesRequiredError, ProviderConnectionRefusedError, ProviderCallError, importProviderDocuments: vi.fn() }
})

import { ProviderConnectionRefusedError, type ImportDocumentsResult } from '../import-documents'
import { ProviderCallError } from '@/lib/providers/with-provider-call'
import {
  DOCUMENT_IMPORT_LEASE_MS,
  runDocumentImportContinuation,
} from '../document-import-continuation'
import {
  DOCUMENT_IMPORT_SERVER_MAX_FAILURES,
  documentImportServerMayClaim,
  type DocumentImportRunSummary,
} from '../document-import-run'

const MINUTE = 60_000
const iso = (ms: number) => new Date(ms).toISOString()

/** Hreidur AB's run: 2 740 of 17 219, its tab silent for a day. */
function stoppedRun(now: number, overrides: Partial<DocumentImportRunSummary> = {}): DocumentImportRunSummary {
  return {
    provider: 'fortnox',
    startedAt: iso(now - 25 * 60 * MINUTE),
    updatedAt: iso(now - 24 * 60 * MINUTE),
    complete: false,
    total: 17219,
    scanned: 2740,
    linked: 762,
    skipped: 2,
    unmatched: 1976,
    failed: 0,
    locked: 0,
    lockedPeriods: [],
    unmatchedSamples: [],
    unreachableSources: [],
    nextCursor: 'file-2740',
    needsReconnect: false,
    ...overrides,
  }
}

function slice(overrides: Partial<ImportDocumentsResult> = {}): ImportDocumentsResult {
  return {
    provider: 'fortnox',
    scanned: 5000,
    linked: 1200,
    skipped: 0,
    unmatched: 3800,
    failed: 0,
    locked: 0,
    lockedPeriods: [],
    dryRun: false,
    unmatchedSamples: [],
    total: 17219,
    partial: true,
    nextCursor: 'file-7740',
    unreachableSources: [],
    ...overrides,
  }
}

interface Setup {
  run: DocumentImportRunSummary
  role?: string | null
  consents?: { id: string; provider: string; created_at: string | null }[]
  ledger?: { imported_at: string | null; created_at: string } | null
  archived?: boolean
}

/**
 * One extension_data row behind a compare-and-set the way PostgREST runs it:
 * an update matches only while id and updated_at are the version read, and
 * every write moves updated_at (update_updated_at_column).
 */
function database(now: number, setup: Setup) {
  let version = 0
  const stamp = () => `2026-11-01T12:00:00.${String(++version).padStart(6, '0')}+00:00`
  const row = { id: 'row-1', company_id: 'company-1', user_id: 'user-1', value: setup.run as unknown, updated_at: stamp() }
  const writes: DocumentImportRunSummary[] = []
  let beforeListingAnswers: (() => void) | null = null

  const mock = createTableMockSupabase({
    extension_data: (chain) => {
      const update = chain.find((call) => call.method === 'update')
      if (!update) {
        const listed = { ...row }
        beforeListingAnswers?.()
        return { data: [listed] }
      }
      const filters = Object.fromEntries(
        chain.filter((call) => call.method === 'eq').map((call) => [call.args[0], call.args[1]]),
      )
      if (filters.id !== row.id || filters.updated_at !== row.updated_at) return { data: [] }
      row.value = (update.args[0] as { value: unknown }).value
      row.updated_at = stamp()
      writes.push(row.value as DocumentImportRunSummary)
      return { data: [{ updated_at: row.updated_at }] }
    },
    companies: { data: { archived_at: setup.archived ? iso(now - MINUTE) : null } },
    company_members: { data: setup.role === null ? null : { role: setup.role ?? 'owner' } },
    provider_consents: {
      data: setup.consents ?? [{ id: 'consent-1', provider: 'fortnox', created_at: iso(now - 26 * 60 * MINUTE) }],
    },
    sie_imports: {
      data: setup.ledger === undefined
        ? { imported_at: iso(now - 25.5 * 60 * MINUTE), created_at: iso(now - 25.6 * 60 * MINUTE) }
        : setup.ledger,
    },
  })

  return {
    supabase: mock.supabase as unknown as SupabaseClient,
    mock,
    row,
    writes,
    stored: () => row.value as DocumentImportRunSummary,
    /** Someone else (a worker, a tab) writes the row between our read and our write. */
    writeElsewhere: (value: Partial<DocumentImportRunSummary> = {}) => {
      row.value = { ...(row.value as DocumentImportRunSummary), ...value }
      row.updated_at = stamp()
    },
    onListing: (callback: () => void) => {
      beforeListingAnswers = callback
    },
  }
}

describe('runDocumentImportContinuation (crm#1581)', () => {
  let clock: number
  const now = () => clock

  beforeEach(() => {
    vi.clearAllMocks()
    clock = Date.now()
  })

  const run = (db: ReturnType<typeof database>, importDocuments: ReturnType<typeof vi.fn>, deadlineIn = 11.5 * MINUTE) =>
    runDocumentImportContinuation({
      supabase: db.supabase,
      deadline: clock + deadlineIn,
      hardDeadline: Date.now() + 13 * MINUTE,
      now,
      importDocuments: importDocuments as never,
      workerId: 'worker-1',
    })

  it('carries a silent run on from its cursor as the member who drove it, to the end', async () => {
    const db = database(clock, { run: stoppedRun(clock) })
    const importDocuments = vi.fn()
      .mockResolvedValueOnce(slice())
      .mockResolvedValueOnce(slice({ scanned: 9479, linked: 2400, unmatched: 7079, partial: false, nextCursor: null }))

    const outcome = await run(db, importDocuments)

    expect(importDocuments).toHaveBeenNthCalledWith(1, expect.objectContaining({
      companyId: 'company-1', userId: 'user-1', consentId: 'consent-1', cursor: 'file-2740',
      sweepDeadline: clock + 11.5 * MINUTE,
    }))
    expect(importDocuments).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursor: 'file-7740' }))
    // Claimed under a lease first, then every slice folded under it.
    expect(db.writes[0]).toMatchObject({ scanned: 2740, lease: { owner: 'worker-1', until: iso(clock + DOCUMENT_IMPORT_LEASE_MS) } })
    expect(db.writes[1]).toMatchObject({ scanned: 7740, driver: 'server', lease: { owner: 'worker-1' } })
    expect(db.stored()).toMatchObject({
      complete: true, scanned: 17219, linked: 4362, unmatched: 12855, nextCursor: null,
      driver: 'server', consentId: 'consent-1', startedAt: stoppedRun(clock).startedAt,
    })
    expect(db.stored()).not.toHaveProperty('lease')
    expect(outcome).toMatchObject({ eligible: 1, claimed: 1, slices: 2, completed: 1 })
  })

  it('leaves a run alone while its tab still drives it', async () => {
    const db = database(clock, { run: stoppedRun(clock, { updatedAt: iso(clock - 2 * MINUTE) }) })
    const importDocuments = vi.fn()

    const outcome = await run(db, importDocuments)

    expect(importDocuments).not.toHaveBeenCalled()
    expect(db.writes).toHaveLength(0)
    expect(outcome.eligible).toBe(0)
  })

  it('keeps driving a run it drove itself, without waiting for a stall', async () => {
    const db = database(clock, { run: stoppedRun(clock, { driver: 'server', updatedAt: iso(clock - MINUTE) }) })
    const importDocuments = vi.fn().mockResolvedValue(slice({ partial: false, nextCursor: null }))

    await run(db, importDocuments)

    expect(importDocuments).toHaveBeenCalledTimes(1)
    expect(db.stored().complete).toBe(true)
  })

  it('lets another worker have a run it claimed first', async () => {
    const db = database(clock, { run: stoppedRun(clock) })
    db.onListing(() => db.writeElsewhere({ lease: { owner: 'worker-2', until: iso(clock + DOCUMENT_IMPORT_LEASE_MS) } }))
    const importDocuments = vi.fn()

    const outcome = await run(db, importDocuments)

    expect(importDocuments).not.toHaveBeenCalled()
    expect(db.writes).toHaveLength(0)
    expect(db.stored().lease?.owner).toBe('worker-2')
    expect(outcome).toMatchObject({ eligible: 1, claimed: 0 })
  })

  it('stops, and leaves the run to the tab, when the tab writes in between', async () => {
    const db = database(clock, { run: stoppedRun(clock) })
    const importDocuments = vi.fn().mockImplementation(async () => {
      // The laptop woke: its tab folded a slice of its own while ours ran.
      db.writeElsewhere({ driver: 'browser', scanned: 2900, nextCursor: 'file-2900', lease: undefined })
      return slice()
    })

    const outcome = await run(db, importDocuments)

    expect(importDocuments).toHaveBeenCalledTimes(1)
    expect(db.stored()).toMatchObject({ driver: 'browser', scanned: 2900, nextCursor: 'file-2900' })
    expect(outcome).toMatchObject({ claimed: 1, slices: 1, completed: 0 })
  })

  it('lets go when time runs out, so the next run takes the run on at once', async () => {
    const db = database(clock, { run: stoppedRun(clock) })
    const importDocuments = vi.fn().mockImplementation(async () => {
      clock += 9 * MINUTE
      return slice()
    })

    const outcome = await run(db, importDocuments)

    expect(importDocuments).toHaveBeenCalledTimes(1)
    expect(db.stored()).toMatchObject({ scanned: 7740, nextCursor: 'file-7740', driver: 'server', complete: false })
    expect(db.stored()).not.toHaveProperty('lease')
    expect(outcome).toMatchObject({ claimed: 1, slices: 1, completed: 0, failed: 0 })
    // Released and driven by the server: the next cron run continues it.
    expect(documentImportServerMayClaim(db.stored(), clock + MINUTE)).toBe(true)
  })

  it('starts nothing with less than four minutes of sweep left', async () => {
    const db = database(clock, { run: stoppedRun(clock) })
    const importDocuments = vi.fn()

    await run(db, importDocuments, 3 * MINUTE)

    expect(importDocuments).not.toHaveBeenCalled()
    expect(db.writes).toHaveLength(0)
  })

  it('marks a run the provider refused as waiting for a reconnect, and lets go', async () => {
    const db = database(clock, { run: stoppedRun(clock) })
    const importDocuments = vi.fn().mockRejectedValue(new ProviderConnectionRefusedError('fortnox', 'PROVIDER_AUTH_EXPIRED', 401))

    const outcome = await run(db, importDocuments)

    expect(db.stored()).toMatchObject({ needsReconnect: true, nextCursor: 'file-2740', scanned: 2740 })
    expect(db.stored()).not.toHaveProperty('lease')
    expect(outcome.reconnect).toBe(1)
    expect(documentImportServerMayClaim(db.stored(), clock + 60 * MINUTE)).toBe(false)
  })

  it('counts a failed attempt and waits before the next, five in a row stop the tries', async () => {
    const db = database(clock, { run: stoppedRun(clock) })
    const importDocuments = vi.fn().mockRejectedValue(new Error('Fortnox 503'))

    const outcome = await run(db, importDocuments)

    expect(db.stored()).toMatchObject({ serverFailures: 1, serverRetryAt: iso(clock + 5 * MINUTE), scanned: 2740 })
    expect(db.stored()).not.toHaveProperty('lease')
    expect(outcome.failed).toBe(1)
    expect(documentImportServerMayClaim(db.stored(), clock + 4 * MINUTE)).toBe(false)
    expect(documentImportServerMayClaim(db.stored(), clock + 6 * MINUTE)).toBe(true)

    const lastTry = database(clock, { run: stoppedRun(clock, { serverFailures: DOCUMENT_IMPORT_SERVER_MAX_FAILURES - 1 }) })
    await run(lastTry, importDocuments)
    expect(lastTry.stored().serverFailures).toBe(DOCUMENT_IMPORT_SERVER_MAX_FAILURES)
    expect(documentImportServerMayClaim(lastTry.stored(), clock + 24 * 60 * MINUTE)).toBe(false)
  })

  it('takes a slice that stops short without moving as a failure, not a loop', async () => {
    const db = database(clock, { run: stoppedRun(clock) })
    const importDocuments = vi.fn().mockResolvedValue(slice({ nextCursor: 'file-2740' }))

    await run(db, importDocuments)

    expect(importDocuments).toHaveBeenCalledTimes(1)
    expect(db.stored()).toMatchObject({ serverFailures: 1, scanned: 2740 })
  })

  it('defers a slice cut at the hard stop without counting it as a failure', async () => {
    const db = database(clock, { run: stoppedRun(clock) })
    const importDocuments = vi.fn().mockRejectedValue(new ExecutionBudgetExceeded('underlag-continuation'))

    const outcome = await run(db, importDocuments)

    expect(db.stored()).not.toHaveProperty('lease')
    expect(db.stored()).not.toHaveProperty('serverFailures')
    expect(outcome).toMatchObject({ claimed: 1, failed: 0 })
  })

  it('reads the connection the run recorded when the company has several', async () => {
    const db = database(clock, {
      run: stoppedRun(clock, { consentId: 'consent-2' }),
      consents: [
        { id: 'consent-1', provider: 'fortnox', created_at: iso(clock - 30 * 60 * MINUTE) },
        { id: 'consent-2', provider: 'fortnox', created_at: iso(clock - 30 * 60 * MINUTE) },
      ],
    })
    const importDocuments = vi.fn().mockResolvedValue(slice({ partial: false, nextCursor: null }))

    await run(db, importDocuments)

    expect(importDocuments).toHaveBeenCalledWith(expect.objectContaining({ consentId: 'consent-2' }))
  })

  describe('lets go of a run for good, without touching the provider', () => {
    const cases: [string, (now: number) => Setup][] = [
      ['the member who drove it can no longer write', (now) => ({ run: stoppedRun(now), role: 'viewer' })],
      ['the member who drove it left the company', (now) => ({ run: stoppedRun(now), role: null })],
      ['the company is archived', (now) => ({ run: stoppedRun(now), archived: true })],
      ['several connections could be meant', (now) => ({
        run: stoppedRun(now),
        consents: [
          { id: 'consent-1', provider: 'fortnox', created_at: iso(now - 30 * 60 * MINUTE) },
          { id: 'consent-2', provider: 'fortnox', created_at: iso(now - 30 * 60 * MINUTE) },
        ],
      })],
      ['the connection was made after the run started', (now) => ({
        run: stoppedRun(now),
        consents: [{ id: 'consent-1', provider: 'fortnox', created_at: iso(now - 60 * MINUTE) }],
      })],
      ['a ledger import landed after the run started', (now) => ({
        run: stoppedRun(now),
        ledger: { imported_at: iso(now - 60 * MINUTE), created_at: iso(now - 61 * MINUTE) },
      })],
    ]

    it.each(cases)('when %s', async (_reason, setup) => {
      const db = database(clock, setup(clock))
      const importDocuments = vi.fn()

      const outcome = await run(db, importDocuments)

      expect(importDocuments).not.toHaveBeenCalled()
      expect(db.stored()).toMatchObject({ serverFailures: DOCUMENT_IMPORT_SERVER_MAX_FAILURES, scanned: 2740 })
      expect(outcome).toMatchObject({ eligible: 1, claimed: 0, released: 1 })
      expect(documentImportServerMayClaim(db.stored(), clock + MINUTE)).toBe(false)
    })
  })

  it('re-checks the run during a long slice and lets go when another writer took it', async () => {
    const db = database(clock, { run: stoppedRun(clock) })
    const importDocuments = vi.fn().mockImplementation(async (opts) => {
      clock += 61_000
      db.writeElsewhere({ nextCursor: 'file-2900', lease: undefined })
      const proceed = await opts.shouldContinue()
      expect(proceed).toBe(false)
      return slice()
    })

    const outcome = await run(db, importDocuments)

    expect(outcome.slices).toBe(0)
    expect(db.stored().lease).toBeUndefined()
  })

  it('lets go of a missing Fortnox license instead of retrying it as transient', async () => {
    const db = database(clock, { run: stoppedRun(clock) })
    const importDocuments = vi.fn().mockRejectedValue(new ProviderCallError('PROVIDER_LICENSE_MISSING', 'fortnox', 'license missing'))

    const outcome = await run(db, importDocuments)

    expect(db.stored()).toMatchObject({ serverFailures: DOCUMENT_IMPORT_SERVER_MAX_FAILURES, scanned: 2740 })
    expect(db.stored()).not.toHaveProperty('lease')
    expect(outcome).toMatchObject({ released: 1, failed: 0, reconnect: 0 })
    expect(documentImportServerMayClaim(db.stored(), clock + MINUTE)).toBe(false)
  })

  it('lists only unfinished runs touched in the last two weeks, oldest first', async () => {
    const db = database(clock, { run: stoppedRun(clock, { updatedAt: iso(clock - 2 * MINUTE) }) })

    await run(db, vi.fn())

    expect(db.mock.findCalls('extension_data', 'eq')).toEqual(expect.arrayContaining([
      ['extension_id', 'arcim-migration'],
      ['key', 'document_import_run'],
      ['value->>complete', 'false'],
    ]))
    // Runs waiting on a reconnect or given up on never take a place in the fifty.
    expect(db.mock.findCalls('extension_data', 'or')).toEqual([
      ['value->>needsReconnect.is.null,value->>needsReconnect.eq.false'],
      ['value->>serverFailures.is.null,value->>serverFailures.in.(0,1,2,3,4)'],
    ])
    expect(db.mock.findCall('extension_data', 'gte')).toEqual(['updated_at', iso(clock - 14 * 24 * 60 * MINUTE)])
    expect(db.mock.findCall('extension_data', 'order')).toEqual(['updated_at', { ascending: true }])
  })
})
