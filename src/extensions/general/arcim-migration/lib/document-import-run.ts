/**
 * The latest underlag run, kept for the page that started it.
 *
 * The import runs as a chain of time-budgeted slices driven by the browser
 * (import-documents.ts), and its outcome used to live only in that tab: a
 * reload, a closed laptop or a run that stopped part-way left nothing to show,
 * and a byrå could not tell whether every underlag had come in (crm#1410).
 * Each real slice is folded into one summary per company in extension_data,
 * so the connections list can say what the latest run found, linked and left,
 * and whether it reached the end of the provider's list.
 *
 * One summary, not a history: a run that starts from the top replaces it. A
 * slice joins it when it starts where the summary stopped, so no file is
 * counted twice.
 *
 * The server owns that point for the run's own tab: every answer carries the
 * run id (its startedAt), the tab sends it back, and a slice of that run
 * starts at the saved point even when the tab sends an earlier cursor
 * (continuationCursor). The tab sends an earlier cursor when it lost an
 * answer the server had already folded, for example when the laptop slept
 * mid-slice, and retries that slice. The fold used to refuse the retry as a
 * repeat, and every slice after it too, because the tab's cursor stayed one
 * slice behind: the summary froze at 2,740 files while the run went on to
 * link 4,354 (crm#1581).
 *
 * A tab still looping on an older run sends the older run's id: it neither
 * moves nor joins the newer run, which would otherwise skip the files in
 * between.
 *
 * The summary also says who drives the run (crm#1581). A run used to move
 * only while its tab was open and awake: a 17 219-file Fortnox run took six
 * bursts over twenty hours of a laptop's waking time. The server now
 * continues a run its tab left silent (document-import-continuation.ts), one
 * driver at a time: whoever answered the latest slice keeps driving, and the
 * other side takes over only once the run has stalled.
 */

import type { ExtensionSettings } from '@/lib/extensions/types'
import type { ImportDocumentsResult, UnreachableAttachmentSource } from './import-documents'

/** extension_data key, per company, under the arcim-migration extension. */
export const DOCUMENT_IMPORT_RUN_KEY = 'document_import_run'

const MAX_UNMATCHED_SAMPLES = 20

/** Who answered the latest slice: the tab's chain, or the server's continuation. */
export type DocumentImportRunDriver = 'browser' | 'server'

/** A server worker holding the run while it works through slices. */
export interface DocumentImportRunLease {
  owner: string
  until: string
}

export interface DocumentImportRunSummary {
  provider: string
  startedAt: string
  /** When the latest slice of the run answered. */
  updatedAt: string
  /** The run reached the end of the provider's list. */
  complete: boolean
  /** Underlag in the provider's list, as the latest slice counted them. */
  total: number
  scanned: number
  linked: number
  skipped: number
  unmatched: number
  failed: number
  locked: number
  lockedPeriods: string[]
  /** The first unmatched files, for support to name the verifikat. */
  unmatchedSamples: ImportDocumentsResult['unmatchedSamples']
  unreachableSources: UnreachableAttachmentSource[]
  /** Where the next slice of an unfinished run continues; null once complete. */
  nextCursor: string | null
  /**
   * The run stopped because the provider refused the connection (a dead
   * token, or a permission the files need): a reconnect, then a new run,
   * carries on. Absent on summaries stored before it existed.
   */
  needsReconnect?: boolean
  /** Who answered the latest slice. Absent on summaries stored before it existed: the tab. */
  driver?: DocumentImportRunDriver
  /**
   * The connection (provider_consents id) the run reads, so the server
   * continues it against the same one. Absent on summaries stored before it
   * existed: the company's one accepted connection of the provider is meant.
   */
  consentId?: string
  /** A server worker holds the run until then (document-import-continuation.ts). */
  lease?: DocumentImportRunLease
  /** Server attempts in a row that failed since the latest slice answered. */
  serverFailures?: number
  /** The server tries again no earlier than this after a failed attempt. */
  serverRetryAt?: string
}

/** Who folds a slice in, against which connection, and for which run. */
export interface DocumentImportSliceSource {
  driver: DocumentImportRunDriver
  consentId?: string
  /** The run id (the run's startedAt) the slice's chain belongs to; absent when the tab sent none. */
  run?: string | null
}

/**
 * The summary without what a server worker keeps on it while it drives: a
 * slice that answered, or a refusal, starts the server's count over.
 */
export function withoutServerHold(summary: DocumentImportRunSummary): DocumentImportRunSummary {
  const { lease: _lease, serverFailures: _failures, serverRetryAt: _retryAt, ...rest } = summary
  return rest
}

/**
 * Where a continuation slice starts: the cursor the tab sent, or the point
 * the saved run already reached when that is further. Every file before that
 * point was handled and counted, so starting earlier would only run it twice.
 * A new run (no cursor), a finished run, or a run with another provider keeps
 * the tab's cursor.
 *
 * Only for the tab's own run (the route checks the run id it sends back). A
 * tab still looping on an older run that jumped to a newer run's point would
 * make the newer run skip the files in between.
 */
export function continuationCursor(
  saved: Pick<DocumentImportRunSummary, 'provider' | 'complete' | 'nextCursor'> | null,
  provider: string,
  cursor: string | null,
): string | null {
  if (cursor === null || !saved || saved.complete || saved.provider !== provider || saved.nextCursor === null) {
    return cursor
  }
  return saved.nextCursor > cursor ? saved.nextCursor : cursor
}

/**
 * A slice that started after `cursor` belongs to the saved run when the run
 * is unfinished, has the same provider, and the slice starts exactly where
 * the run stopped.
 *
 * The run's own chain (`run` is the run's startedAt, sent back by the tab)
 * may also start past that point: an earlier slice of it answered, but its
 * fold was not stored (a failed write, or a retry that raced the first try).
 * Its files are linked; only their counts are missing.
 *
 * A slice that starts before the point would count files twice. Another
 * run's chain never joins past it.
 */
function continuesRun(
  previous: DocumentImportRunSummary | null,
  provider: string,
  cursor: string | null,
  run: string | null,
): previous is DocumentImportRunSummary {
  if (
    cursor === null ||
    previous === null ||
    previous.complete ||
    previous.provider !== provider ||
    previous.nextCursor === null
  ) {
    return false
  }
  if (cursor === previous.nextCursor) return true
  return run !== null && run === previous.startedAt && cursor > previous.nextCursor
}

/**
 * The summary after one more slice, or null when the slice is not part of
 * the recorded run: a dry run, or a slice that does not continue it
 * (continuesRun). `source.run` is the run id the slice's chain sent with it.
 */
export function foldDocumentImportSlice(
  previous: DocumentImportRunSummary | null,
  slice: ImportDocumentsResult,
  cursor: string | null,
  at: string,
  source: DocumentImportSliceSource = { driver: 'browser' },
): DocumentImportRunSummary | null {
  if (slice.dryRun) return null
  const continues = continuesRun(previous, slice.provider, cursor, source.run ?? null)
  if (cursor !== null && !continues) return null
  const base = continues ? previous : null

  // A refusal holds until a reconnect; an error (a timeout, a 5xx) is the
  // answer of the slice that met it only. Every slice lists every source
  // again, so a later slice that got through must not keep the earlier error.
  const unreachableByScope = new Map(
    (base?.unreachableSources ?? [])
      .filter((entry) => entry.reason !== 'error')
      .map((entry) => [entry.scope, entry]),
  )
  for (const entry of slice.unreachableSources) unreachableByScope.set(entry.scope, entry)
  const consentId = source.consentId ?? base?.consentId

  return {
    provider: slice.provider,
    startedAt: base?.startedAt ?? at,
    updatedAt: at,
    complete: !slice.partial,
    total: slice.total,
    scanned: (base?.scanned ?? 0) + slice.scanned,
    linked: (base?.linked ?? 0) + slice.linked,
    skipped: (base?.skipped ?? 0) + slice.skipped,
    unmatched: (base?.unmatched ?? 0) + slice.unmatched,
    failed: (base?.failed ?? 0) + slice.failed,
    locked: (base?.locked ?? 0) + slice.locked,
    lockedPeriods: [...new Set([...(base?.lockedPeriods ?? []), ...slice.lockedPeriods])].sort(),
    unmatchedSamples: [...(base?.unmatchedSamples ?? []), ...slice.unmatchedSamples].slice(
      0,
      MAX_UNMATCHED_SAMPLES,
    ),
    unreachableSources: [...unreachableByScope.values()],
    nextCursor: slice.partial ? slice.nextCursor : null,
    // A slice that answered got through: the connection works again.
    needsReconnect: false,
    driver: source.driver,
    ...(consentId ? { consentId } : {}),
  }
}

/**
 * The summary after a slice the provider refused outright, or null when that
 * slice is not part of the recorded run. A run it continues keeps its counts
 * and resume point and waits for a reconnect; a run that could not even start
 * (no cursor) replaces the summary with an empty one that says so.
 */
export function markDocumentImportNeedsReconnect(
  previous: DocumentImportRunSummary | null,
  provider: string,
  cursor: string | null,
  at: string,
  run: string | null = null,
): DocumentImportRunSummary | null {
  const continues = continuesRun(previous, provider, cursor, run)
  if (continues) return { ...withoutServerHold(previous), updatedAt: at, needsReconnect: true }
  if (cursor !== null) return null
  return {
    provider,
    startedAt: at,
    updatedAt: at,
    complete: false,
    total: 0,
    scanned: 0,
    linked: 0,
    skipped: 0,
    unmatched: 0,
    failed: 0,
    locked: 0,
    lockedPeriods: [],
    unmatchedSamples: [],
    unreachableSources: [],
    nextCursor: null,
    needsReconnect: true,
  }
}

const COUNT_FIELDS = ['total', 'scanned', 'linked', 'skipped', 'unmatched', 'failed', 'locked'] as const

const optional = (value: unknown, type: 'string' | 'number' | 'boolean') =>
  value === undefined || typeof value === type

function isLease(value: unknown): value is DocumentImportRunLease {
  if (!value || typeof value !== 'object') return false
  const lease = value as Record<string, unknown>
  return typeof lease.owner === 'string' && typeof lease.until === 'string'
}

function isDocumentImportRunSummary(value: unknown): value is DocumentImportRunSummary {
  if (!value || typeof value !== 'object') return false
  const summary = value as Record<string, unknown>
  return (
    typeof summary.provider === 'string' &&
    typeof summary.startedAt === 'string' &&
    typeof summary.updatedAt === 'string' &&
    typeof summary.complete === 'boolean' &&
    COUNT_FIELDS.every((field) => typeof summary[field] === 'number') &&
    Array.isArray(summary.lockedPeriods) &&
    Array.isArray(summary.unmatchedSamples) &&
    Array.isArray(summary.unreachableSources) &&
    (summary.nextCursor === null || typeof summary.nextCursor === 'string') &&
    optional(summary.needsReconnect, 'boolean') &&
    (summary.driver === undefined || summary.driver === 'browser' || summary.driver === 'server') &&
    optional(summary.consentId, 'string') &&
    (summary.lease === undefined || isLease(summary.lease)) &&
    optional(summary.serverFailures, 'number') &&
    optional(summary.serverRetryAt, 'string')
  )
}

/** A stored value as a summary, or null when it is not one. */
export function parseDocumentImportRun(value: unknown): DocumentImportRunSummary | null {
  return isDocumentImportRunSummary(value) ? value : null
}

/**
 * An unfinished run whose latest slice answered longer ago than this is no
 * longer moving: the tab that drove it closed or gave up. A slice answers
 * within about a minute and a half, retries included well under ten.
 */
export const DOCUMENT_IMPORT_RUN_STALL_MS = 10 * 60_000

/**
 * The server continues a run only this long after its latest slice
 * answered. A run silent for longer was left, not interrupted: whoever
 * starts it again decides.
 */
export const DOCUMENT_IMPORT_SERVER_WINDOW_MS = 14 * 24 * 60 * 60_000

/** Failed server attempts in a row after which the run waits for a person. */
export const DOCUMENT_IMPORT_SERVER_MAX_FAILURES = 5

/** What the run reads besides its own summary, looked up where it is judged. */
export interface DocumentImportRunFacts {
  /**
   * The accepted connection the run reads, or null when it has none or
   * several could be meant (documentImportRunConnection).
   */
  connection: { id: string; createdAt: string | null } | null
  /** When the company's latest completed ledger (SIE) import landed; null when none did. */
  ledgerImportedAt: string | null
}

/**
 * The accepted connection a run reads: the one it recorded, or, for a run
 * recorded before it said, the company's only accepted connection of its
 * provider. Null when there is none, or several could be meant.
 */
export function documentImportRunConnection<T extends { id: string; provider: string }>(
  summary: DocumentImportRunSummary,
  acceptedConsents: readonly T[],
): T | null {
  if (summary.consentId) {
    return acceptedConsents.find((c) => c.id === summary.consentId && c.provider === summary.provider) ?? null
  }
  const sameProvider = acceptedConsents.filter((c) => c.provider === summary.provider)
  return sameProvider.length === 1 ? sameProvider[0] : null
}

/**
 * The facts a run is judged on, from the company's accepted connections and
 * its latest completed ledger import. One reading for the worker, the
 * import route and /status.
 */
export function documentImportRunFacts(
  summary: DocumentImportRunSummary,
  acceptedConsents: readonly { id: string; provider: string; createdAt: string | null }[],
  latestLedgerImport: { imported_at: string | null; created_at: string | null } | null,
): DocumentImportRunFacts {
  const connection = documentImportRunConnection(summary, acceptedConsents)
  return {
    connection: connection ? { id: connection.id, createdAt: connection.createdAt } : null,
    // Rows from before imported_at existed landed when they were created.
    ledgerImportedAt: latestLedgerImport ? (latestLedgerImport.imported_at ?? latestLedgerImport.created_at) : null,
  }
}

/**
 * The run started after every moment in `notBefore`: the sweep skips every
 * file up to the cursor, so a run is continued only while those files are
 * the ones it saw. Not when the connection was made after it started (it may
 * read another Fortnox database), nor when a ledger import landed after it
 * started (files it left unmatched may match now): those start from the top.
 * One rule for the page's resume (arcim-document-import-flow.ts) and the
 * server's continuation (documentImportRunStillCurrent). A missing or
 * unreadable moment holds nothing back.
 */
export function documentImportRunStartedAfter(
  run: Pick<DocumentImportRunSummary, 'startedAt'>,
  notBefore: readonly (string | null | undefined)[],
): boolean {
  const startedAt = Date.parse(run.startedAt)
  return notBefore.every((at) => typeof at !== 'string' || !(Date.parse(at) > startedAt))
}

/** The run's connection is known, and it and the latest ledger import are older than the run. */
export function documentImportRunStillCurrent(
  summary: DocumentImportRunSummary,
  facts: DocumentImportRunFacts,
): boolean {
  return (
    facts.connection !== null &&
    documentImportRunStartedAfter(summary, [facts.connection.createdAt, facts.ledgerImportedAt])
  )
}

const leaseHeld = (summary: DocumentImportRunSummary, now: number) =>
  summary.lease !== undefined && Date.parse(summary.lease.until) > now

const silentFor = (summary: DocumentImportRunSummary, now: number) => now - Date.parse(summary.updatedAt)

/** Unfinished, not waiting on a person, and recent enough for the server to carry on. */
function serverMayContinue(summary: DocumentImportRunSummary, now: number): boolean {
  return (
    !summary.complete &&
    summary.needsReconnect !== true &&
    typeof summary.nextCursor === 'string' &&
    summary.nextCursor.length > 0 &&
    silentFor(summary, now) <= DOCUMENT_IMPORT_SERVER_WINDOW_MS &&
    (summary.serverFailures ?? 0) < DOCUMENT_IMPORT_SERVER_MAX_FAILURES
  )
}

/** The server carries the run on if it stops moving: the page can say so. */
export function documentImportContinuesOnServer(
  summary: DocumentImportRunSummary,
  now: number,
  facts: DocumentImportRunFacts,
): boolean {
  return serverMayContinue(summary, now) && documentImportRunStillCurrent(summary, facts)
}

/**
 * The server may take the run now, before the facts are looked up: it drove
 * the latest slice, or the tab left the run silent past the stall mark. Not
 * while another worker holds it, nor before a failed attempt's retry time.
 */
export function documentImportServerMayClaim(summary: DocumentImportRunSummary, now: number): boolean {
  if (!serverMayContinue(summary, now) || leaseHeld(summary, now)) return false
  if (summary.serverRetryAt && Date.parse(summary.serverRetryAt) > now) return false
  return summary.driver === 'server' || silentFor(summary, now) > DOCUMENT_IMPORT_RUN_STALL_MS
}

/**
 * The server is driving the run, so a tab must not start a second chain on
 * it: a worker holds it, or the server answered its latest slice moments ago
 * and will take the next one. A run the server stopped trying, or one it
 * waits to retry, is the tab's again.
 */
export function documentImportDrivenByServer(summary: DocumentImportRunSummary, now: number): boolean {
  if (summary.complete || summary.needsReconnect === true) return false
  if (leaseHeld(summary, now)) return true
  if (summary.serverRetryAt && Date.parse(summary.serverRetryAt) > now) return false
  return (
    summary.driver === 'server' &&
    (summary.serverFailures ?? 0) < DOCUMENT_IMPORT_SERVER_MAX_FAILURES &&
    silentFor(summary, now) <= DOCUMENT_IMPORT_RUN_STALL_MS
  )
}

export interface DocumentImportRunStatus extends DocumentImportRunSummary {
  /**
   * Unfinished, silent past DOCUMENT_IMPORT_RUN_STALL_MS, and no worker holds
   * it: a held run is moving, and the server folds its slice only at the end.
   */
  stalled: boolean
  /**
   * Left silent, the server picks the run up again on its own (crm#1581).
   * Always set by this server; a page served by an older one reads it absent.
   */
  continuesOnServer?: boolean
}

/**
 * The summary as the page shows it, judged against the server's clock.
 * Without facts nothing is known about the run's connection, so the server
 * is not said to continue it.
 */
export function documentImportRunStatus(
  summary: DocumentImportRunSummary,
  now: number = Date.now(),
  facts: DocumentImportRunFacts | null = null,
): DocumentImportRunStatus {
  return {
    ...summary,
    stalled: !summary.complete && !leaseHeld(summary, now) && silentFor(summary, now) > DOCUMENT_IMPORT_RUN_STALL_MS,
    continuesOnServer: facts !== null && documentImportContinuesOnServer(summary, now, facts),
  }
}

/** The stored summary, or null when there is none (or it is not one). */
export async function readDocumentImportRun(
  settings: ExtensionSettings,
): Promise<DocumentImportRunSummary | null> {
  const stored = await settings.get<unknown>(DOCUMENT_IMPORT_RUN_KEY)
  return isDocumentImportRunSummary(stored) ? stored : null
}

/**
 * Fold one answered slice into the stored summary. Returns the summary it
 * stored, or null when the slice was not part of the recorded run.
 */
export async function recordDocumentImportSlice(
  settings: ExtensionSettings,
  slice: ImportDocumentsResult,
  cursor: string | null,
  at: string = new Date().toISOString(),
  source: DocumentImportSliceSource = { driver: 'browser' },
): Promise<DocumentImportRunSummary | null> {
  const next = foldDocumentImportSlice(await readDocumentImportRun(settings), slice, cursor, at, source)
  if (next) await settings.set(DOCUMENT_IMPORT_RUN_KEY, next)
  return next
}

/** Mark the stored run as waiting for a reconnect (see markDocumentImportNeedsReconnect). */
export async function recordDocumentImportNeedsReconnect(
  settings: ExtensionSettings,
  provider: string,
  cursor: string | null,
  at: string = new Date().toISOString(),
  run: string | null = null,
): Promise<void> {
  const next = markDocumentImportNeedsReconnect(await readDocumentImportRun(settings), provider, cursor, at, run)
  if (next) await settings.set(DOCUMENT_IMPORT_RUN_KEY, next)
}
