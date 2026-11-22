/**
 * Google Drive as a cloud backup target.
 *
 * Wraps the existing `google-oauth.ts` + `google-drive.ts` clients in the
 * provider contract. Behaviour is unchanged from before the contract existed:
 * the same `drive.file` scope, the same `gnubok/<company>/` folder pair with
 * trashed-folder revalidation, and the same resumable md5-verified uploads.
 *
 * The storage keys keep their original `google_drive_*` names on purpose:
 * every already-connected company has records under them.
 */
import { ROOT_FOLDER_NAME } from './folder-names'
import {
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  fetchUserEmail,
  getOAuthEnv,
  isGoogleOAuthConfigured,
  lacksDriveScope,
  refreshAccessToken,
  revokeToken,
} from './google-oauth'
import {
  DriveFileGoneError,
  ensureFolder,
  getFileMeta,
  updateFile,
  uploadFile,
} from './google-drive'
import {
  CloudScopeMissingError,
  type CloudStorageProvider,
  type PreparedTarget,
  type PrepareTargetParams,
  type PutFileParams,
  type PutFileResult,
} from './cloud-provider'
import type { CloudConnection } from '../types'

export const GOOGLE_CONNECTION_KEY = 'google_drive_connection'
export const GOOGLE_LAST_SYNC_KEY = 'google_drive_last_sync'
export const GOOGLE_SCHEDULE_KEY = 'google_drive_schedule'

function folderLink(folderId: string): string {
  return `https://drive.google.com/drive/folders/${folderId}`
}

export const googleDriveProvider: CloudStorageProvider = {
  id: 'google_drive',
  label: 'Google Drive',
  keys: {
    connection: GOOGLE_CONNECTION_KEY,
    lastSync: GOOGLE_LAST_SYNC_KEY,
    schedule: GOOGLE_SCHEDULE_KEY,
  },
  // Registered with Google as an authorised redirect URI: never change it.
  callbackPath: '/oauth/callback',

  isConfigured: isGoogleOAuthConfigured,

  buildAuthorizationUrl(origin, state) {
    return buildAuthorizationUrl(getOAuthEnv(origin), state)
  },

  async exchangeCode(origin, code) {
    const tokens = await exchangeCodeForTokens(getOAuthEnv(origin), code)
    // What Google granted decides, not what was asked for: a grant without
    // the Drive box ticked can never write a backup, so nothing is stored.
    // The grant is deliberately not revoked: it carries only sign-in scopes,
    // and revoking ends this Google account's grant for the whole client,
    // which could take down a working backup of another company on it.
    if (lacksDriveScope(tokens.scope)) {
      throw new CloudScopeMissingError('Google Drive', `granted: ${tokens.scope}`)
    }
    const email = await fetchUserEmail(tokens.access_token)
    return { refreshToken: tokens.refresh_token, accountLabel: email }
  },

  async revoke(refreshToken) {
    // Google revokes a refresh token directly: no client credentials needed.
    await revokeToken(refreshToken)
  },

  async refreshAccessToken(refreshToken, origin) {
    const refreshed = await refreshAccessToken(getOAuthEnv(origin), refreshToken)
    return refreshed.access_token
  },

  /**
   * Resolve the `gnubok/<company>/` folder pair, revalidating the cached ids.
   *
   * Files created inside a trashed folder are purged with it, so a folder the
   * user trashed or deleted must never receive uploads. `trashed` is inherited
   * from parents, so checking the company folder covers a trashed root too;
   * the root is only re-checked when the company folder needs recreating.
   */
  async prepareTarget({
    accessToken,
    connection,
    companyLabel,
  }: PrepareTargetParams): Promise<PreparedTarget> {
    let rootFolderId = connection.root_folder_id
    let companyFolderId = connection.company_folder_id

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
      const companyFolder = await ensureFolder(accessToken, companyLabel, rootFolderId)
      companyFolderId = companyFolder.id
    }

    const changed =
      rootFolderId !== connection.root_folder_id ||
      companyFolderId !== connection.company_folder_id
    const patch: Partial<CloudConnection> | null = changed
      ? { root_folder_id: rootFolderId, company_folder_id: companyFolderId }
      : null

    return {
      target: { folderId: companyFolderId, webViewLink: folderLink(companyFolderId) },
      connectionPatch: patch,
    }
  },

  /**
   * Update the file in place when we already know its id (Drive keeps ~30 days
   * of prior versions, which gives the backup rolling history without one file
   * per day), falling back to a create when the user deleted it.
   */
  async putFile({
    accessToken,
    target,
    name,
    previousId,
    open,
    contentType,
  }: PutFileParams): Promise<PutFileResult> {
    if (previousId) {
      try {
        return await updateFile(accessToken, previousId, open, contentType)
      } catch (err) {
        if (!(err instanceof DriveFileGoneError)) throw err
        // The user deleted the file in Drive: recreate it.
      }
    }
    return uploadFile(accessToken, target.folderId, name, open, contentType)
  },
}
