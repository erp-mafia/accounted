import type { SupabaseClient } from '@supabase/supabase-js'
import {
  generateFullArchive,
  estimateArchiveSize,
} from '@/lib/reports/full-archive-export'
import {
  getOAuthEnv,
  refreshAccessToken,
  GoogleTokenRefreshError,
} from './google-oauth'
import { ensureFolder, uploadFile } from './google-drive'
import { decryptToken } from './crypto'
import type { GoogleDriveConnection, GoogleDriveLastSync } from '../types'

export const CONNECTION_KEY = 'google_drive_connection'
export const LAST_SYNC_KEY = 'google_drive_last_sync'
export const SCHEDULE_KEY = 'google_drive_schedule'
export const ROOT_FOLDER_NAME = 'gnubok'
export const SIZE_LIMIT_BYTES = 80 * 1024 * 1024

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
      webViewLink: string
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
}

/**
 * Run the end-to-end cloud backup sync: estimate size → refresh token →
 * ensure Drive folder hierarchy → generate archive → upload → persist
 * last_sync. Shared by the manual HTTP handler and the scheduled cron.
 *
 * Settings ops use raw `extension_data` queries (not the extension context
 * wrapper) because the cron runs under the service role with no user session.
 */
export async function performSync(params: PerformSyncParams): Promise<PerformSyncResult> {
  const { supabase, companyId, userId, origin, includeDocuments } = params

  const connection = await loadExtensionData<GoogleDriveConnection>(
    supabase,
    companyId,
    CONNECTION_KEY
  )
  if (!connection) {
    return { ok: false, reason: 'not_connected', message: 'Google Drive not connected' }
  }

  const estimate = await estimateArchiveSize(supabase, companyId, 'all')
  const effectiveBytes = includeDocuments
    ? estimate.total_bytes
    : estimate.total_bytes - estimate.document_bytes
  if (effectiveBytes > SIZE_LIMIT_BYTES) {
    return {
      ok: false,
      reason: 'archive_too_large',
      message: 'Archive exceeds size limit',
      size_bytes: effectiveBytes,
      size_limit_bytes: SIZE_LIMIT_BYTES,
    }
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

  let rootFolderId = connection.root_folder_id
  let companyFolderId = connection.company_folder_id
  if (!rootFolderId) {
    const root = await ensureFolder(accessToken, ROOT_FOLDER_NAME, null)
    rootFolderId = root.id
  }
  if (!companyFolderId) {
    const companyName = await fetchCompanyLabel(supabase, companyId)
    const companyFolder = await ensureFolder(accessToken, companyName, rootFolderId)
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

  const archive = await generateFullArchive(supabase, companyId, {
    scope: 'all',
    include_documents: includeDocuments,
  })

  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+/, '')
  const fileName = `arkiv_full_${stamp}.zip`

  const uploaded = await uploadFile(accessToken, companyFolderId, fileName, archive)

  const lastSync: GoogleDriveLastSync = {
    at: new Date().toISOString(),
    file_id: uploaded.id,
    file_name: uploaded.name,
    file_size_bytes: uploaded.size_bytes,
    folder_id: companyFolderId,
  }
  await saveExtensionData(supabase, companyId, userId, LAST_SYNC_KEY, lastSync)

  return { ok: true, lastSync, webViewLink: uploaded.web_view_link }
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

async function fetchCompanyLabel(
  supabase: SupabaseClient,
  companyId: string
): Promise<string> {
  const { data } = await supabase
    .from('company_settings')
    .select('company_name, org_number')
    .eq('company_id', companyId)
    .maybeSingle()
  const name = (data?.company_name as string) || 'företag'
  const org = (data?.org_number as string) || companyId.slice(0, 8)
  return `${name} (${org})`.replace(/[\\/]/g, '-')
}
