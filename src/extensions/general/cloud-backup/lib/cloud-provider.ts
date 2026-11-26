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

/**
 * Thrown by a provider's storage calls when the grant lacks the scope the
 * backup needs. Google's consent screen lets a person untick Drive and still
 * approve, and every Drive call made with such a grant answers 403
 * "insufficient authentication scopes". Retrying can never succeed: the user
 * must reconnect and grant the scope, so `performSync` flags the connection
 * instead of failing the same way every night.
 */
export class CloudScopeMissingError extends Error {
  constructor(providerLabel: string, detail: string) {
    super(`${providerLabel} grant lacks the storage scope: ${detail}`)
    this.name = 'CloudScopeMissingError'
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

/**
 * The bytes of one file, made while they are uploaded: held whole (twice,
 * while it was collected), a large archive ran the backup function out of
 * memory. Each call starts the file again from its first byte, for an upload
 * that has to be sent over.
 */
export type FileBytes = () => AsyncIterable<Uint8Array>

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
  data: FileBytes
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
  /**
   * Throws {@link CloudScopeMissingError} when the provider granted less than
   * the backup needs; nothing may be stored for such a grant.
   */
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
  /** Throws {@link CloudScopeMissingError} when the grant lacks the scope. */
  prepareTarget(params: PrepareTargetParams): Promise<PreparedTarget>
  /**
   * Write one file into the target, replacing any existing file of that name.
   * Implementations send `data` as it is read, never holding more of it than
   * one request, read it to its end, and verify the stored bytes against the
   * provider's own checksum: a silently corrupted backup is worse than a
   * failed one. Throws {@link CloudScopeMissingError} when the grant lacks
   * the scope.
   */
  putFile(params: PutFileParams): Promise<PutFileResult>
}
