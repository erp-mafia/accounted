/**
 * Dropbox as a cloud backup target.
 *
 * The app is **app-folder** scoped, so every path here is relative to
 * `Apps/<app name>/` in the user's Dropbox and the app can never see anything
 * else they store there. That gives the same "we only touch what we created"
 * guarantee as the Google `drive.file` scope.
 *
 * Consequences for the sync engine, all handled here:
 *   - There is no root folder to create: Dropbox's own app folder plays that
 *     role, so company folders sit directly inside it (Drive needs the extra
 *     `gnubok/` level because it writes into the user's whole Drive).
 *   - Files are addressed by path, not id, and writes are `overwrite`. Nothing
 *     can go stale, so `prepareTarget` makes no network call and the
 *     "user deleted the file" recovery the Drive target needs has no analogue.
 */
import {
  buildDropboxAuthorizationUrl,
  exchangeDropboxCodeForTokens,
  fetchDropboxAccountEmail,
  getDropboxOAuthEnv,
  isDropboxOAuthConfigured,
  refreshDropboxAccessToken,
  revokeDropboxToken,
  DROPBOX_CALLBACK_PATH,
} from './dropbox-oauth'
import { sanitizeDropboxName, uploadDropboxFile } from './dropbox-client'
import type {
  CloudStorageProvider,
  PreparedTarget,
  PrepareTargetParams,
  PutFileParams,
  PutFileResult,
} from './cloud-provider'
import type { CloudConnection } from '../types'

export const DROPBOX_CONNECTION_KEY = 'dropbox_connection'
export const DROPBOX_LAST_SYNC_KEY = 'dropbox_last_sync'
export const DROPBOX_SCHEDULE_KEY = 'dropbox_schedule'

/**
 * Link into the Dropbox web UI.
 *
 * App-folder scoped calls only ever see app-relative paths, so the API cannot
 * tell us where the app folder sits in the user's account. `Apps/<app name>`
 * is the answer, and the app name is chosen when the Dropbox app is
 * registered: a self-hoster registers their own. `DROPBOX_APP_FOLDER_NAME`
 * lets a deployment state it and get a deep link; without it we send the user
 * to `Apps/`, which is always correct and one click away. Never guess the
 * name: a link into the wrong folder reads as a lost backup.
 */
function folderLink(companyFolderPath: string): string {
  const appFolder = process.env.DROPBOX_APP_FOLDER_NAME
  const base = 'https://www.dropbox.com/home/Apps'
  if (!appFolder) return base
  return `${base}/${encodeURIComponent(appFolder)}${companyFolderPath
    .split('/')
    .map(encodeURIComponent)
    .join('/')}`
}

export const dropboxProvider: CloudStorageProvider = {
  id: 'dropbox',
  label: 'Dropbox',
  keys: {
    connection: DROPBOX_CONNECTION_KEY,
    lastSync: DROPBOX_LAST_SYNC_KEY,
    schedule: DROPBOX_SCHEDULE_KEY,
  },
  callbackPath: DROPBOX_CALLBACK_PATH,

  isConfigured: isDropboxOAuthConfigured,

  buildAuthorizationUrl(origin, state) {
    return buildDropboxAuthorizationUrl(getDropboxOAuthEnv(origin), state)
  },

  async exchangeCode(origin, code) {
    const tokens = await exchangeDropboxCodeForTokens(getDropboxOAuthEnv(origin), code)
    const email = await fetchDropboxAccountEmail(tokens.access_token)
    return { refreshToken: tokens.refresh_token, accountLabel: email }
  },

  async revoke(refreshToken, origin) {
    // Dropbox revokes by access token, so mint a short-lived one first. The
    // whole thing is best-effort: a dead refresh token is already revoked.
    try {
      const env = getDropboxOAuthEnv(origin)
      const refreshed = await refreshDropboxAccessToken(env, refreshToken)
      await revokeDropboxToken(refreshed.access_token)
    } catch {
      // Swallow: the local disconnect must complete regardless.
    }
  },

  async refreshAccessToken(refreshToken, origin) {
    const refreshed = await refreshDropboxAccessToken(
      getDropboxOAuthEnv(origin),
      refreshToken
    )
    return refreshed.access_token
  },

  /**
   * Pure path derivation: Dropbox creates missing parent folders on upload, so
   * there is nothing to create up front and nothing that can be trashed
   * underneath us.
   */
  async prepareTarget({
    connection,
    companyLabel,
  }: PrepareTargetParams): Promise<PreparedTarget> {
    const companyFolderPath = `/${sanitizeDropboxName(companyLabel)}`
    const patch: Partial<CloudConnection> | null =
      connection.company_folder_path === companyFolderPath
        ? null
        : { company_folder_path: companyFolderPath }

    return {
      target: {
        folderId: companyFolderPath,
        webViewLink: folderLink(companyFolderPath),
      },
      connectionPatch: patch,
    }
  },

  /**
   * `previousId` is ignored: the path is derived from the file name, and an
   * overwrite write is correct whether or not the file is already there. That
   * also means a file the user deleted in Dropbox simply reappears on the next
   * sync, with no recovery path needed.
   */
  async putFile({
    accessToken,
    target,
    name,
    data,
  }: PutFileParams): Promise<PutFileResult> {
    const path = `${target.folderId}/${sanitizeDropboxName(name)}`
    const uploaded = await uploadDropboxFile(accessToken, path, data)
    return {
      id: uploaded.path,
      name: uploaded.name,
      size_bytes: uploaded.size_bytes,
    }
  },
}
