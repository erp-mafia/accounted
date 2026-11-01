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
 */

import type { ExtensionSettings } from '@/lib/extensions/types'
import type { ImportDocumentsResult, UnreachableAttachmentSource } from './import-documents'

/** extension_data key, per company, under the arcim-migration extension. */
export const DOCUMENT_IMPORT_RUN_KEY = 'document_import_run'

const MAX_UNMATCHED_SAMPLES = 20

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
 * (continuesRun). `run` is the run id the tab sent with the slice.
 */
export function foldDocumentImportSlice(
  previous: DocumentImportRunSummary | null,
  slice: ImportDocumentsResult,
  cursor: string | null,
  at: string,
  run: string | null = null,
): DocumentImportRunSummary | null {
  if (slice.dryRun) return null
  const continues = continuesRun(previous, slice.provider, cursor, run)
  if (cursor !== null && !continues) return null
  const base = continues ? previous : null

  const unreachableByScope = new Map(
    (base?.unreachableSources ?? []).map((entry) => [entry.scope, entry]),
  )
  for (const entry of slice.unreachableSources) unreachableByScope.set(entry.scope, entry)

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
  if (continues) return { ...previous, updatedAt: at, needsReconnect: true }
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
    (summary.needsReconnect === undefined || typeof summary.needsReconnect === 'boolean')
  )
}

/**
 * An unfinished run whose latest slice answered longer ago than this is no
 * longer moving: the tab that drove it closed or gave up. A slice answers
 * within about a minute and a half, retries included well under ten.
 */
export const DOCUMENT_IMPORT_RUN_STALL_MS = 10 * 60_000

export interface DocumentImportRunStatus extends DocumentImportRunSummary {
  /** Unfinished and silent past DOCUMENT_IMPORT_RUN_STALL_MS. */
  stalled: boolean
}

/** The summary as the page shows it, judged against the server's clock. */
export function documentImportRunStatus(
  summary: DocumentImportRunSummary,
  now: number = Date.now(),
): DocumentImportRunStatus {
  return {
    ...summary,
    stalled: !summary.complete && now - Date.parse(summary.updatedAt) > DOCUMENT_IMPORT_RUN_STALL_MS,
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
  run: string | null = null,
): Promise<DocumentImportRunSummary | null> {
  const next = foldDocumentImportSlice(await readDocumentImportRun(settings), slice, cursor, at, run)
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
