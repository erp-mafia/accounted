import { createHash } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  generateFullArchive,
  generateBaseDataArchive,
  ARCHIVE_OVERHEAD_BYTES,
} from '@/lib/reports/full-archive-export'
import { buildDriveFolderReadme } from '@/lib/reports/archive-readme'
import { getBranding } from '@/lib/branding/service'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import {
  getOAuthEnv,
  refreshAccessToken,
  GoogleTokenRefreshError,
} from './google-oauth'
import {
  DriveFileGoneError,
  ensureFolder,
  getFileMeta,
  updateFile,
  uploadFile,
  type UploadResult,
} from './google-drive'
import { decryptToken } from './crypto'
import type {
  DriveFileState,
  GoogleDriveConnection,
  GoogleDriveLastSync,
} from '../types'

export const CONNECTION_KEY = 'google_drive_connection'
export const LAST_SYNC_KEY = 'google_drive_last_sync'
export const SCHEDULE_KEY = 'google_drive_schedule'
export const ROOT_FOLDER_NAME = 'gnubok'
/**
 * Per-FILE ceiling, not per-backup: the backup splits into one archive per
 * räkenskapsår plus Grunddata.zip, and uploads are resumable/chunked. The
 * bound left is JSZip building each archive in memory on a serverless
 * function, hence 300 MB rather than "unlimited".
 *
 * Memory budget: worst-case transient usage is ~3x this limit (~900 MB):
 * JSZip holds the input blobs while generateAsync accumulates output chunks
 * and then concatenates them into the final ArrayBuffer. The upload path
 * adds no further copies (md5/sha256 hash via zero-copy Buffer views,
 * resumable 8 MB chunk views, no multipart concatenation), and files are
 * generated and uploaded one at a time. That fits the Vercel default
 * function memory (2048 MB) with ~2x headroom; raise this limit only
 * together with an explicit memory bump in vercel.json.
 */
export const SIZE_LIMIT_BYTES = 300 * 1024 * 1024
/** Bump to force a re-upload of every file when the archive format changes. */
export const ARCHIVE_FORMAT_VERSION = 2

export type SyncFailureReason =
  | 'not_connected'
  | 'needs_reauth'
  | 'archive_too_large'
  | 'upload_failed'
  | 'internal'

export type PerformSyncResult =
  | {
      ok: true
      lastSync: GoogleDriveLastSync
      /** Link to the company's backup folder in Drive. */
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
}

interface PlannedFile {
  key: string
  kind: DriveFileState['kind']
  periodId?: string
  name: string
  contentType: string
  fingerprint: string
  includeDocuments: boolean
  generate: () => Promise<ArrayBuffer>
}

interface PeriodRow {
  id: string
  period_start: string
  period_end: string
}

/**
 * Run the end-to-end cloud backup sync against the per-fiscal-year layout:
 *
 *   gnubok/<company>/Arkiv <år>.zip   one per räkenskapsår
 *   gnubok/<company>/Grunddata.zip    registers, SIE originals, audit trail
 *   gnubok/<company>/LÄSMIG.txt       folder map
 *
 * Every file carries a fingerprint (entry/document counts + latest
 * timestamps); only files whose fingerprint changed are regenerated and
 * uploaded, in place (Drive keeps ~30 days of prior versions). State is
 * persisted after every upload, so an interrupted run resumes where it
 * stopped instead of re-uploading finished years.
 *
 * Settings ops use raw `extension_data` queries (not the extension context
 * wrapper) because the cron runs under the service role with no user session.
 */
export async function performSync(params: PerformSyncParams): Promise<PerformSyncResult> {
  const { supabase, companyId, userId, origin } = params

  const connection = await loadExtensionData<GoogleDriveConnection>(
    supabase,
    companyId,
    CONNECTION_KEY
  )
  if (!connection) {
    return { ok: false, reason: 'not_connected', message: 'Google Drive not connected' }
  }

  const env = getOAuthEnv(origin)
  const refreshToken = decryptToken(connection.refresh_token_encrypted)
  let accessToken: string
  try {
    const refreshed = await refreshAccessToken(env, refreshToken)
    accessToken = refreshed.access_token
  } catch (err) {
    if (err instanceof GoogleTokenRefreshError && err.isInvalidGrant) {
      // The refresh token is permanently dead (revoked or expired). Flag the
      // connection so the cron stops retrying it and the UI can ask the user
      // to reconnect. Other failures (network, 5xx) stay throwing: they are
      // transient and worth retrying.
      const flagged: GoogleDriveConnection = {
        ...connection,
        status: 'needs_reauth',
        needs_reauth_at: new Date().toISOString(),
      }
      await saveExtensionData(supabase, companyId, userId, CONNECTION_KEY, flagged)
      return {
        ok: false,
        reason: 'needs_reauth',
        message: 'Google Drive authorization expired; reconnect required',
      }
    }
    throw err
  }

  const company = await fetchCompanyInfo(supabase, companyId)

  let rootFolderId = connection.root_folder_id
  let companyFolderId = connection.company_folder_id
  // Revalidate cached folder ids: files created inside a trashed folder are
  // purged with it, so a folder the user trashed or deleted must never
  // receive uploads. `trashed` is inherited from parents, so checking the
  // company folder covers a trashed root too; the root is only re-checked
  // when the company folder needs recreating.
  if (companyFolderId) {
    const meta = await getFileMeta(accessToken, companyFolderId)
    if (!meta || meta.trashed) companyFolderId = null
  }
  if (!companyFolderId && rootFolderId) {
    const rootMeta = await getFileMeta(accessToken, rootFolderId)
    if (!rootMeta || rootMeta.trashed) rootFolderId = null
  }
  if (!rootFolderId) {
    const root = await ensureFolder(accessToken, ROOT_FOLDER_NAME, null)
    rootFolderId = root.id
  }
  if (!companyFolderId) {
    const companyFolder = await ensureFolder(accessToken, company.label, rootFolderId)
    companyFolderId = companyFolder.id
  }
  if (
    rootFolderId !== connection.root_folder_id ||
    companyFolderId !== connection.company_folder_id ||
    connection.status === 'needs_reauth'
  ) {
    // A successful refresh also clears a stale needs_reauth flag.
    await saveExtensionData(supabase, companyId, userId, CONNECTION_KEY, {
      ...connection,
      root_folder_id: rootFolderId,
      company_folder_id: companyFolderId,
      status: 'active',
      needs_reauth_at: undefined,
    })
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
        generateFullArchive(supabase, companyId, {
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
      generateBaseDataArchive(supabase, companyId, {
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
    generate: async () => textToArrayBuffer(readmeText),
  })

  // ---- Execute: regenerate + upload only what changed. ----
  const previous = await loadExtensionData<GoogleDriveLastSync>(
    supabase,
    companyId,
    LAST_SYNC_KEY
  )
  const stateByKey = new Map<string, DriveFileState>()
  for (const file of previous?.files ?? []) {
    stateByKey.set(fileKey(file), file)
  }

  const persistSnapshot = async (): Promise<GoogleDriveLastSync> => {
    const files = [...stateByKey.values()]
    const lastSync: GoogleDriveLastSync = {
      at: new Date().toISOString(),
      folder_id: companyFolderId!,
      files,
      total_size_bytes: files.reduce((sum, f) => sum + f.size_bytes, 0),
    }
    await saveExtensionData(supabase, companyId, userId, LAST_SYNC_KEY, lastSync)
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

    const bytes = await plan.generate()
    let uploaded: UploadResult
    if (prev?.file_id && prev.file_name === plan.name) {
      try {
        uploaded = await updateFile(accessToken, prev.file_id, bytes, plan.contentType)
      } catch (err) {
        if (err instanceof DriveFileGoneError) {
          // The user deleted the file in Drive: recreate it.
          uploaded = await uploadFile(
            accessToken,
            companyFolderId,
            plan.name,
            bytes,
            plan.contentType
          )
        } else {
          throw err
        }
      }
    } else {
      uploaded = await uploadFile(accessToken, companyFolderId, plan.name, bytes, plan.contentType)
    }

    stateByKey.set(plan.key, {
      kind: plan.kind,
      period_id: plan.periodId,
      file_id: uploaded.id,
      file_name: uploaded.name,
      size_bytes: uploaded.size_bytes,
      fingerprint: plan.fingerprint,
      sha256: sha256Hex(bytes),
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
    webViewLink: `https://drive.google.com/drive/folders/${companyFolderId}`,
    uploadedCount,
    skippedCount,
  }
}

function fileKey(file: DriveFileState): string {
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

function textToArrayBuffer(text: string): ArrayBuffer {
  const bytes = new TextEncoder().encode(text)
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
}

async function fetchLatestAuditAt(
  supabase: SupabaseClient,
  companyId: string
): Promise<string> {
  const { data } = await supabase
    .from('audit_log')
    .select('created_at')
    .eq('company_id', companyId)
    .order('created_at', { ascending: false })
    .limit(1)
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
