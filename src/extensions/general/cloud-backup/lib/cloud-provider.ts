/**
 * Provider-agnostic contract for a cloud backup target.
 *
 * `performSync()` builds the same archive set regardless of destination and
 * talks to storage only through this interface. Everything provider-specific
 * (OAuth dialect, folder model, upload protocol, checksum verification) lives
 * behind an implementation: `google-provider.ts`, `dropbox-provider.ts`.
 *
 * Adding a provider therefore means writing one implementation and listing it
 * in `provider-registry.ts`, without touching the sync engine.
 */
import type { CloudConnection, CloudProviderId } from '../types'

/**
 * Thrown when a provider's token endpoint rejects a refresh attempt. Carries
 * the HTTP status and raw response body so callers can distinguish a
 * permanently dead refresh token (400 invalid_grant) from transient failures.
 */
export class CloudTokenRefreshError extends Error {
  readonly status: number
  readonly body: string

  constructor(providerLabel: string, status: number, body: string) {
    super(`${providerLabel} token refresh failed: ${status} ${body}`)
    this.name = 'CloudTokenRefreshError'
    this.status = status
    this.body = body
  }

  /**
   * True when the provider reports the refresh token itself is dead (revoked,
   * expired, or the grant was invalidated). Retrying will never succeed;
   * the user must re-consent. Google and Dropbox both use OAuth 2.0's
   * `invalid_grant` for this.
   */
  get isInvalidGrant(): boolean {
    return this.status === 400 && this.body.includes('invalid_grant')
  }
}

/** The three `extension_data` keys a provider owns for a company. */
export interface CloudStorageKeys {
  connection: string
  lastSync: string
  schedule: string
}

/** Where one company's archives are written, in provider-native terms. */
export interface CloudTarget {
  /** Drive: the company folder id. Dropbox: the company folder path. */
  folderId: string
  /** Link a human can open to reach the backup folder. */
  webViewLink: string
}

export interface PreparedTarget {
  target: CloudTarget
  /**
   * Fields to merge into the stored connection because preparing the target
   * changed them (e.g. Drive re-created a folder the user trashed). Null when
   * nothing changed, so the common path writes no connection record.
   */
  connectionPatch: Partial<CloudConnection> | null
}

export interface PutFileResult {
  /** Provider-native handle: a Drive file id, or the Dropbox path. */
  id: string
  name: string
  size_bytes: number
}

export interface PutFileParams {
  accessToken: string
  target: CloudTarget
  name: string
  /**
   * Handle recorded by the previous sync for this same file name. Providers
   * that address files by id use it to update in place (and to detect that
   * the user deleted the file); path-addressed providers ignore it.
   */
  previousId?: string
  data: ArrayBuffer
  contentType: string
}

export interface PrepareTargetParams {
  accessToken: string
  connection: CloudConnection
  /** `Testbolag AB (556000-0000)`: the per-company folder name. */
  companyLabel: string
}

export interface CloudStorageProvider {
  readonly id: CloudProviderId
  /** Human label used in logs, errors and alert emails. */
  readonly label: string
  readonly keys: CloudStorageKeys
  /**
   * OAuth callback path relative to the extension's route root. Each provider
   * needs its own: the redirect URI is registered with the provider, so they
   * can never be merged after the fact.
   */
  readonly callbackPath: string

  /** False when this deployment has no OAuth credentials for the provider. */
  isConfigured(): boolean
  buildAuthorizationUrl(origin: string, state: string): string
  exchangeCode(
    origin: string,
    code: string
  ): Promise<{ refreshToken: string; accountLabel: string }>
  /**
   * Best-effort: a failed revoke must not block a local disconnect.
   * `origin` resolves the same deployment credentials as the connect flow.
   */
  revoke(refreshToken: string, origin: string): Promise<void>
  /** Throws {@link CloudTokenRefreshError} on rejection. */
  refreshAccessToken(refreshToken: string, origin: string): Promise<string>
  prepareTarget(params: PrepareTargetParams): Promise<PreparedTarget>
  /**
   * Write one file into the target, replacing any existing file of that name.
   * Implementations verify the stored bytes against the provider's own
   * checksum: a silently corrupted backup is worse than a failed one.
   */
  putFile(params: PutFileParams): Promise<PutFileResult>
}
