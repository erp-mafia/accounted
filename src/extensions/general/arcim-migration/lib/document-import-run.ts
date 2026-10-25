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
 * slice joins it only when it continues from the cursor the summary stopped
 * at, so a second tab's chain, or a retried slice whose first answer already
 * landed, never counts twice.
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
}

/**
 * The summary after one more slice, or null when the slice is not part of
 * the recorded run (a dry run, or a cursor the summary did not stop at).
 */
export function foldDocumentImportSlice(
  previous: DocumentImportRunSummary | null,
  slice: ImportDocumentsResult,
  cursor: string | null,
  at: string,
): DocumentImportRunSummary | null {
  if (slice.dryRun) return null
  const continues =
    cursor !== null && previous !== null && !previous.complete && previous.nextCursor === cursor
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
    (summary.nextCursor === null || typeof summary.nextCursor === 'string')
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

/** Fold one answered slice into the stored summary. */
export async function recordDocumentImportSlice(
  settings: ExtensionSettings,
  slice: ImportDocumentsResult,
  cursor: string | null,
  at: string = new Date().toISOString(),
): Promise<void> {
  const next = foldDocumentImportSlice(await readDocumentImportRun(settings), slice, cursor, at)
  if (next) await settings.set(DOCUMENT_IMPORT_RUN_KEY, next)
}
