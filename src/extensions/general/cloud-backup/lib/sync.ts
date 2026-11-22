import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  streamFullArchive,
  streamBaseDataArchive,
  ARCHIVE_OVERHEAD_BYTES,
} from '@/lib/reports/full-archive-export'
import { buildDriveFolderReadme } from '@/lib/reports/archive-readme'
import { getBranding } from '@/lib/branding/service'
import { createServiceClient } from '@/lib/supabase/server'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import {
  CloudScopeMissingError,
  CloudTokenRefreshError,
  type CloudStorageProvider,
  type PreparedTarget,
  type PutFileResult,
} from './cloud-provider'
import { googleDriveProvider } from './google-provider'
import { decryptToken } from './crypto'
import type {
  CloudConnection,
  CloudFileState,
  CloudLastSync,
  CloudReauthReason,
} from '../types'

/**
 * Google Drive's storage keys, re-exported for the call sites that predate
 * multi-provider support. Provider-aware code reads `provider.keys` instead:
 * Dropbox owns `dropbox_*` records alongside these.
 */
export const CONNECTION_KEY = 'google_drive_connection'
export const LAST_SYNC_KEY = 'google_drive_last_sync'
/**
 * Per-FILE ceiling, not per-backup: the backup splits into one archive per
 * räkenskapsår plus Grunddata.zip, and uploads are resumable/chunked. Past
 * it a year is archived without its documents (allowDocumentFallback) or the
 * sync refuses.
 *
 * Memory no longer grows with the archive: it goes from the ZIP writer to the
 * provider a chunk at a time (Dropbox still takes it whole), so a run holds
 * the file being written (at most the behandlingshistorik, once, as bytes),
 * the underlag read ahead and one 8 MB chunk. Holding each archive whole, and
 * its history as rows and text besides, ran a large company's nightly backup
 * out of the function's memory.
 */
export const SIZE_LIMIT_BYTES = 300 * 1024 * 1024
/** Bump to force a re-upload of every file when the archive format changes. */
export const ARCHIVE_FORMAT_VERSION = 3

export type SyncFailureReason =
  | 'not_connected'
  | 'needs_reauth'
  | 'archive_too_large'
  | 'upload_failed'
  | 'internal'
  /**
   * `startDeadline` passed before every changed file was uploaded. Not a
   * failure: the finished files are persisted and the next run resumes.
   */
  | 'deferred'

export type PerformSyncResult =
  | {
      ok: true
      lastSync: CloudLastSync
      /** Link to the company's backup folder at the provider. */
      webViewLink: string
      uploadedCount: number
      skippedCount: number
    }
  | {
      ok: false
      reason: SyncFailureReason
      message: string
      size_bytes?: number
      size_limit_bytes?: number
      /** Set with reason `needs_reauth`. */
      reauthReason?: CloudReauthReason
    }

interface PerformSyncParams {
  supabase: SupabaseClient
  companyId: string
  userId: string
  origin: string
  includeDocuments: boolean
  /**
   * When a single archive file with documents exceeds the size limit, fall
   * back to building THAT file without document blobs instead of failing.
   * The cron and the post-connect sync set this; the manual flow leaves it
   * off and lets the user choose via a dialog.
   */
  allowDocumentFallback?: boolean
  /**
   * Destination. Defaults to Google Drive, which is what every caller meant
   * before Dropbox existed. Each provider keeps its own connection, last-sync
   * and schedule records, so syncing one never disturbs the other.
   */
  provider?: CloudStorageProvider
  /**
   * Epoch ms after which no further archive may start. The cron passes one so
   * a run stops between files instead of being killed mid-upload by the
   * function's time limit; each finished file is already persisted, so the
   * next run resumes where this one stopped. Omitted: no limit.
   */
  startDeadline?: number
}

interface PlannedFile {
  key: string
  kind: CloudFileState['kind']
  periodId?: string
  name: string
  contentType: string
  fingerprint: string
  includeDocuments: boolean
  /** Starts the file's bytes; each call produces them again. */
  generate: () => AsyncIterable<Uint8Array>
}

interface PeriodRow {
  id: string
  period_start: string
  period_end: string
}

/**
 * Run the end-to-end cloud backup sync against the per-fiscal-year layout:
 *
 *   <company>/Arkiv <år>.zip   one per räkenskapsår
 *   <company>/Grunddata.zip    registers, SIE originals, audit trail
 *   <company>/LÄSMIG.txt       folder map
 *
 * (Google Drive nests that company folder under a `gnubok/` root; Dropbox's
 * app folder already provides one.)
 *
 * Every file carries a fingerprint (entry/document counts + latest
 * timestamps); only files whose fingerprint changed are regenerated and
 * uploaded, in place (both providers keep prior versions for ~30 days). State
 * is persisted after every upload, so an interrupted run resumes where it
 * stopped instead of re-uploading finished years.
 *
 * Settings ops use raw `extension_data` queries (not the extension context
 * wrapper) because the cron runs under the service role with no user session.
 */
export async function performSync(params: PerformSyncParams): Promise<PerformSyncResult> {
  const { supabase, companyId, userId, origin } = params
  const provider = params.provider ?? googleDriveProvider
  const keys = provider.keys

  // Archive generation reads the private `documents` bucket, whose SELECT
  // policy only covers the uploader's own folder. User-triggered syncs pass
  // a user-bound client, which would silently drop every colleague-uploaded
  // document from the backup (manifest rows flip to 'error'). The service
  // client is used for archive generation only; authorization happened at
  // the extension dispatcher (or the cron), and every archive query filters
  // by the explicit companyId.
  const archiveClient = createServiceClient()

  const connection = await loadExtensionData<CloudConnection>(
    supabase,
    companyId,
    keys.connection
  )
  if (!connection) {
    return {
      ok: false,
      reason: 'not_connected',
      message: `${provider.label} not connected`,
    }
  }

  // The stored record as of now: preparing the target may rewrite it.
  let current = connection

  /**
   * Flag the connection so the cron stops retrying it and the UI can ask the
   * user to reconnect. An already flagged connection keeps its original
   * `needs_reauth_at`: the cron alerts once per incident, anchored on it.
   */
  const flagNeedsReauth = async (
    reauthReason: CloudReauthReason,
    message: string
  ): Promise<PerformSyncResult> => {
    const flagged: CloudConnection = {
      ...current,
      status: 'needs_reauth',
      needs_reauth_at:
        (current.status === 'needs_reauth' && current.needs_reauth_at) ||
        new Date().toISOString(),
      needs_reauth_reason: reauthReason,
    }
    await saveExtensionData(supabase, companyId, userId, keys.connection, flagged)
    return { ok: false, reason: 'needs_reauth', message, reauthReason }
  }
  const scopeMissing = () =>
    flagNeedsReauth(
      'missing_scope',
      `${provider.label} access was granted without the storage permission; reconnect required`
    )

  const refreshToken = decryptToken(connection.refresh_token_encrypted)
  let accessToken: string
  try {
    accessToken = await provider.refreshAccessToken(refreshToken, origin)
  } catch (err) {
    if (err instanceof CloudTokenRefreshError && err.isInvalidGrant) {
      // The refresh token is permanently dead (revoked or expired). Other
      // failures (network, 5xx) stay throwing: they are transient and worth
      // retrying.
      return flagNeedsReauth(
        'token_revoked',
        `${provider.label} authorization expired; reconnect required`
      )
    }
    throw err
  }

  const company = await fetchCompanyInfo(supabase, companyId)

  let prepared: PreparedTarget
  try {
    prepared = await provider.prepareTarget({
      accessToken,
      connection,
      companyLabel: company.label,
    })
  } catch (err) {
    // The token refreshed but the grant lacks the storage scope: the same
    // answer would come back every night, so this is a reconnect, not a
    // failure to retry.
    if (err instanceof CloudScopeMissingError) return scopeMissing()
    throw err
  }
  const { target, connectionPatch } = prepared
  if (connectionPatch || connection.status === 'needs_reauth') {
    // A successful refresh and target check also clears a stale flag.
    current = {
      ...connection,
      ...connectionPatch,
      status: 'active',
      needs_reauth_at: undefined,
      needs_reauth_reason: undefined,
    }
    await saveExtensionData(supabase, companyId, userId, keys.connection, current)
  }

  // ---- Fingerprint basis: three paged reads + one point read. ----
  const periods = await fetchAllRows<PeriodRow>(({ from, to }) =>
    supabase
      .from('fiscal_periods')
      .select('id, period_start, period_end')
      .eq('company_id', companyId)
      .order('period_start', { ascending: true })
      .range(from, to)
  )
  const entries = await fetchAllRows<{
    id: string
    fiscal_period_id: string
    updated_at: string | null
  }>(({ from, to }) =>
    supabase
      .from('journal_entries')
      .select('id, fiscal_period_id, updated_at')
      .eq('company_id', companyId)
      .in('status', ['posted', 'reversed'])
      .order('id', { ascending: true })
      .range(from, to)
  )
  const docs = await fetchAllRows<{
    id: string
    journal_entry_id: string | null
    file_size_bytes: number | null
    created_at: string | null
  }>(({ from, to }) =>
    supabase
      .from('document_attachments')
      .select('id, journal_entry_id, file_size_bytes, created_at')
      .eq('company_id', companyId)
      .order('id', { ascending: true })
      .range(from, to)
  )
  // Inline rättelse and dimension retag rewrite lines without touching the
  // entry row, so their logs are what tell a year archive its lines changed.
  const lineChanges = (
    await Promise.all(
      (['journal_entry_rattelse_log', 'dimension_retag_log'] as const).map((table) =>
        fetchAllRows<{ journal_entry_id: string; created_at: string }>(({ from, to }) =>
          supabase
            .from(table)
            .select('journal_entry_id, created_at')
            .eq('company_id', companyId)
            .order('id', { ascending: true })
            .range(from, to)
        )
      )
    )
  ).flat()
  const latestAuditAt = await fetchLatestAuditAt(supabase, companyId)

  const entryToPeriod = new Map(entries.map((e) => [e.id, e.fiscal_period_id]))

  interface Stats {
    entryCount: number
    maxEntryUpdated: string
    docCount: number
    docBytes: number
    maxDocCreated: string
  }
  const emptyStats = (): Stats => ({
    entryCount: 0,
    maxEntryUpdated: '',
    docCount: 0,
    docBytes: 0,
    maxDocCreated: '',
  })
  const statsByPeriod = new Map<string, Stats>()
  for (const period of periods) statsByPeriod.set(period.id, emptyStats())
  for (const entry of entries) {
    const stats = statsByPeriod.get(entry.fiscal_period_id)
    if (!stats) continue
    stats.entryCount++
    if (entry.updated_at && entry.updated_at > stats.maxEntryUpdated) {
      stats.maxEntryUpdated = entry.updated_at
    }
  }
  // A line change counts as a change to its entry: only one newer than every
  // entry update moves the fingerprint, so other years keep theirs.
  for (const change of lineChanges) {
    const periodId = entryToPeriod.get(change.journal_entry_id)
    const stats = periodId ? statsByPeriod.get(periodId) : undefined
    if (stats && change.created_at > stats.maxEntryUpdated) {
      stats.maxEntryUpdated = change.created_at
    }
  }
  const baseStats = emptyStats()
  for (const doc of docs) {
    const periodId = doc.journal_entry_id ? entryToPeriod.get(doc.journal_entry_id) : undefined
    const stats = (periodId && statsByPeriod.get(periodId)) || baseStats
    stats.docCount++
    stats.docBytes += Number(doc.file_size_bytes) || 0
    if (doc.created_at && doc.created_at > stats.maxDocCreated) {
      stats.maxDocCreated = doc.created_at
    }
  }

  // ---- Plan the file set. ----
  const planned: PlannedFile[] = []

  const decideDocuments = (
    docBytes: number
  ): { includeDocuments: boolean } | { tooLargeBytes: number } => {
    let includeDocuments = params.includeDocuments
    if (includeDocuments && ARCHIVE_OVERHEAD_BYTES + docBytes > SIZE_LIMIT_BYTES) {
      if (params.allowDocumentFallback) {
        includeDocuments = false
      } else {
        return { tooLargeBytes: ARCHIVE_OVERHEAD_BYTES + docBytes }
      }
    }
    return { includeDocuments }
  }

  for (const period of periods) {
    const stats = statsByPeriod.get(period.id)!
    const decision = decideDocuments(stats.docBytes)
    if ('tooLargeBytes' in decision) {
      return {
        ok: false,
        reason: 'archive_too_large',
        message: `Archive for ${period.period_start}..${period.period_end} exceeds size limit`,
        size_bytes: decision.tooLargeBytes,
        size_limit_bytes: SIZE_LIMIT_BYTES,
      }
    }
    const includeDocuments = decision.includeDocuments
    planned.push({
      key: `period:${period.id}`,
      kind: 'period',
      periodId: period.id,
      name: arkivFileName(period),
      contentType: 'application/zip',
      fingerprint: [
        `v${ARCHIVE_FORMAT_VERSION}`,
        stats.entryCount,
        stats.maxEntryUpdated,
        stats.docCount,
        stats.maxDocCreated,
        `docs:${includeDocuments ? 1 : 0}`,
      ].join('|'),
      includeDocuments,
      generate: () =>
        streamFullArchive(archiveClient, companyId, {
          scope: 'period',
          period_id: period.id,
          include_documents: includeDocuments,
        }),
    })
  }

  const baseDecision = decideDocuments(baseStats.docBytes)
  if ('tooLargeBytes' in baseDecision) {
    return {
      ok: false,
      reason: 'archive_too_large',
      message: 'Grunddata archive exceeds size limit',
      size_bytes: baseDecision.tooLargeBytes,
      size_limit_bytes: SIZE_LIMIT_BYTES,
    }
  }
  planned.push({
    key: 'base',
    kind: 'base',
    name: 'Grunddata.zip',
    contentType: 'application/zip',
    fingerprint: [
      `v${ARCHIVE_FORMAT_VERSION}`,
      // Any data change writes the audit log, so this covers master data.
      latestAuditAt,
      baseStats.docCount,
      baseStats.maxDocCreated,
      `docs:${baseDecision.includeDocuments ? 1 : 0}`,
    ].join('|'),
    includeDocuments: baseDecision.includeDocuments,
    generate: () =>
      streamBaseDataArchive(archiveClient, companyId, {
        include_documents: baseDecision.includeDocuments,
      }),
  })

  // Folder README: fingerprinted on its content (no timestamp inside), so it
  // uploads once and again only when the text or company name changes.
  const readmeText = buildDriveFolderReadme({
    companyName: company.name,
    orgNumber: company.orgNumber,
    generatedAt: '',
    appName: getBranding().appName,
  })
  planned.push({
    key: 'readme',
    kind: 'readme',
    name: 'LÄSMIG.txt',
    contentType: 'text/plain',
    fingerprint: `v${ARCHIVE_FORMAT_VERSION}|${sha256Hex(textToArrayBuffer(readmeText)).slice(0, 16)}`,
    includeDocuments: true,
    generate: async function* () {
      yield new Uint8Array(textToArrayBuffer(readmeText))
    },
  })

  // ---- Execute: regenerate + upload only what changed. ----
  const previous = await loadExtensionData<CloudLastSync>(
    supabase,
    companyId,
    keys.lastSync
  )
  // File state only counts for the destination it was written to. After the
  // user trashed the folder (Drive makes a new one), reconnected another
  // account, or the company was renamed (a new Dropbox path), every file is
  // missing there and must be uploaded again, not skipped as unchanged.
  const sameDestination =
    previous?.folder_id === target.folderId &&
    (!previous.account_email || previous.account_email === current.account_email)
  const stateByKey = new Map<string, CloudFileState>()
  for (const file of sameDestination ? (previous.files ?? []) : []) {
    stateByKey.set(fileKey(file), file)
  }

  const persistSnapshot = async (): Promise<CloudLastSync> => {
    const files = [...stateByKey.values()]
    const lastSync: CloudLastSync = {
      at: new Date().toISOString(),
      folder_id: target.folderId,
      web_view_link: target.webViewLink,
      account_email: current.account_email,
      files,
      total_size_bytes: files.reduce((sum, f) => sum + f.size_bytes, 0),
    }
    await saveExtensionData(supabase, companyId, userId, keys.lastSync, lastSync)
    return lastSync
  }

  let uploadedCount = 0
  let skippedCount = 0
  for (const plan of planned) {
    const prev = stateByKey.get(plan.key)
    if (prev && prev.fingerprint === plan.fingerprint && prev.file_name === plan.name) {
      skippedCount++
      continue
    }

    if (params.startDeadline !== undefined && Date.now() >= params.startDeadline) {
      // Stop between files: a file started now could be cut off by the
      // function's time limit, losing the work and the rest of the run.
      return {
        ok: false,
        reason: 'deferred',
        message: `time budget reached after ${uploadedCount} file(s); the next run resumes`,
      }
    }

    // The digest of the bytes the provider kept: an upload that starts over
    // produces the file again, and the last one read is the one stored.
    let sha256 = ''
    let uploaded: PutFileResult
    try {
      uploaded = await provider.putFile({
        accessToken,
        target,
        name: plan.name,
        // Only reuse the remote handle when it still belongs to this file
        // name: a renamed archive (a fiscal year that changed shape) must not
        // overwrite the file the old name points at.
        previousId:
          prev?.file_id && prev.file_name === plan.name ? prev.file_id : undefined,
        open: () => withDigest(plan.generate(), (hex) => { sha256 = hex }),
        contentType: plan.contentType,
      })
    } catch (err) {
      if (err instanceof CloudScopeMissingError) return scopeMissing()
      throw err
    }

    stateByKey.set(plan.key, {
      kind: plan.kind,
      period_id: plan.periodId,
      file_id: uploaded.id,
      file_name: uploaded.name,
      size_bytes: uploaded.size_bytes,
      fingerprint: plan.fingerprint,
      sha256,
      included_documents: plan.includeDocuments,
      uploaded_at: new Date().toISOString(),
    })
    uploadedCount++
    // Persist progressively: an interrupted run (time budget, crash) resumes
    // from the finished files instead of re-uploading them.
    await persistSnapshot()
  }

  // Drop state for files no longer planned (e.g. a deleted fiscal period).
  const plannedKeys = new Set(planned.map((p) => p.key))
  for (const key of [...stateByKey.keys()]) {
    if (!plannedKeys.has(key)) stateByKey.delete(key)
  }

  const lastSync = await persistSnapshot()

  return {
    ok: true,
    lastSync,
    webViewLink: target.webViewLink,
    uploadedCount,
    skippedCount,
  }
}

function fileKey(file: CloudFileState): string {
  return file.kind === 'period' ? `period:${file.period_id}` : file.kind
}

/** `Arkiv 2024.zip` for calendar years, full dates for broken years. */
export function arkivFileName(period: PeriodRow): string {
  const year = period.period_start.slice(0, 4)
  const isCalendarYear =
    period.period_start === `${year}-01-01` && period.period_end === `${year}-12-31`
  return isCalendarYear
    ? `Arkiv ${year}.zip`
    : `Arkiv ${period.period_start}_${period.period_end}.zip`
}

function sha256Hex(data: ArrayBuffer): string {
  return createHash('sha256').update(Buffer.from(data)).digest('hex')
}

/** Pass a byte stream on as it is read, and its SHA-256 to `done` once it has been read to the end. */
async function* withDigest(
  source: AsyncIterable<Uint8Array>,
  done: (hex: string) => void
): AsyncGenerator<Uint8Array> {
  const hash = createHash('sha256')
  for await (const chunk of source) {
    hash.update(chunk)
    yield chunk
  }
  done(hash.digest('hex'))
}

function textToArrayBuffer(text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text)
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

async function fetchLatestAuditAt(
  supabase: SupabaseClient,
  companyId: string
): Promise<string> {
  const { data, error } = await supabase
    .from('audit_log')
    .select('created_at')
    .eq('company_id', companyId)
    // extension_data is non-portable runtime state and includes this sync's
    // own progress snapshots. Letting those rows advance the watermark makes
    // every completed backup invalidate Grunddata for the next run.
    .neq('table_name', 'extension_data')
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(1)
  if (error) throw new Error(`Failed to fetch backup audit watermark: ${error.message}`)
  const rows = (data as { created_at: string }[] | null) ?? []
  return rows[0]?.created_at ?? ''
}

export async function loadExtensionData<T>(
  supabase: SupabaseClient,
  companyId: string,
  key: string
): Promise<T | null> {
  const { data } = await supabase
    .from('extension_data')
    .select('value')
    .eq('company_id', companyId)
    .eq('extension_id', 'cloud-backup')
    .eq('key', key)
    .maybeSingle()
  return (data?.value as T) ?? null
}

export async function saveExtensionData<T>(
  supabase: SupabaseClient,
  companyId: string,
  userId: string,
  key: string,
  value: T
): Promise<void> {
  const { error } = await supabase.from('extension_data').upsert(
    {
      user_id: userId,
      company_id: companyId,
      extension_id: 'cloud-backup',
      key,
      value,
    },
    { onConflict: 'company_id,extension_id,key' }
  )
  if (error) throw new Error(`Failed to save extension data: ${error.message}`)
}

async function fetchCompanyInfo(
  supabase: SupabaseClient,
  companyId: string
): Promise<{ name: string; orgNumber: string | null; label: string }> {
  const { data } = await supabase
    .from('company_settings')
    .select('company_name, org_number')
    .eq('company_id', companyId)
    .maybeSingle()
  const name = (data?.company_name as string) || 'företag'
  const orgNumber = (data?.org_number as string) || null
  const label = `${name} (${orgNumber || companyId.slice(0, 8)})`.replace(/[\\/]/g, '-')
  return { name, orgNumber, label }
}
