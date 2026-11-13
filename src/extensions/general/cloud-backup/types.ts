/**
 * Cloud backup storage targets.
 *
 * The extension syncs the same archive set to one or more providers. Each
 * provider owns its own three `extension_data` keys (connection, last sync,
 * schedule), so connecting Dropbox never touches the Google Drive records and
 * the two schedules run independently.
 */
export type CloudProviderId = 'google_drive' | 'dropbox'

/**
 * Why a connection needs reconnecting.
 * - `token_revoked`: the provider rejected the refresh token (400
 *   invalid_grant): it expired or the user removed the app's access.
 * - `missing_scope`: the grant works but lacks the storage scope, because
 *   Google's consent screen lets a person untick Drive and still approve.
 * Records flagged before this field existed carry none: read as
 * `token_revoked`, the only reason that existed then.
 */
export type CloudReauthReason = 'token_revoked' | 'missing_scope'

/**
 * Connection stored per company + provider in extension_data (key
 * `google_drive_connection` / `dropbox_connection`). The refresh token is
 * AES-256-GCM encrypted (see lib/crypto.ts): never store it in plaintext.
 */
export interface CloudConnection {
  refresh_token_encrypted: string
  /** Account identifier shown in the UI: the account email on both providers. */
  account_email: string
  connected_at: string
  /**
   * Google Drive: ID of the top-level "gnubok" folder in the user's Drive.
   * Unused on Dropbox (app-folder scoped, so our root IS the app folder).
   */
  root_folder_id: string | null
  /** Google Drive: ID of the per-company subfolder. Unused on Dropbox. */
  company_folder_id: string | null
  /**
   * Dropbox: app-folder-relative path of the company folder
   * (`/Testbolag AB (556000-0000)`). Unused on Google Drive.
   */
  company_folder_path?: string | null
  /**
   * Connection health. `needs_reauth` means retrying can never succeed: the
   * provider rejected the refresh token permanently (400 invalid_grant), or
   * the grant lacks the storage scope. The cron skips the connection and the
   * UI asks the user to reconnect. Absent/undefined means active
   * (records created before this field existed).
   */
  status?: 'active' | 'needs_reauth'
  /** ISO timestamp of when the dead refresh token was detected. */
  needs_reauth_at?: string
  /** Set together with `status: 'needs_reauth'`. */
  needs_reauth_reason?: CloudReauthReason
}

/**
 * State of one file in the company's backup folder: an `Arkiv <år>.zip`
 * per räkenskapsår, `Grunddata.zip`, and the folder LÄSMIG.txt. Files are
 * updated in place; `fingerprint` decides whether a sync re-uploads them.
 */
export interface CloudFileState {
  kind: 'period' | 'base' | 'readme'
  /** Set when kind = 'period'. */
  period_id?: string
  /**
   * Provider-native handle for the stored file: a Drive file id, or the
   * app-folder-relative path on Dropbox. Opaque to everything but the
   * provider that wrote it.
   */
  file_id: string
  file_name: string
  size_bytes: number
  /** Change-detection key: the file re-uploads only when this differs. */
  fingerprint: string
  /**
   * SHA-256 of the uploaded bytes. The upload itself is verified against the
   * provider's own checksum (Drive md5Checksum, Dropbox content_hash); this
   * hash is recorded for evidentiary value (the user can prove the file in
   * their cloud storage is the one Accounted produced).
   */
  sha256: string
  /** False when the file was built without document blobs (size fallback). */
  included_documents: boolean
  uploaded_at: string
}

/**
 * Last-sync snapshot stored under key `google_drive_last_sync` /
 * `dropbox_last_sync`.
 *
 * Current records carry `files` (per-fiscal-year layout). The flat
 * `file_id`/`file_name`/`file_size_bytes` fields are the legacy single-ZIP
 * layout, kept optional so old records still render.
 */
export interface CloudLastSync {
  at: string
  /**
   * Provider-native handle for the company backup folder: a Drive folder id,
   * or the app-folder-relative path on Dropbox.
   */
  folder_id: string
  /**
   * Link a human can open to reach the backup folder. Written since the
   * Dropbox target landed; absent on older Drive records, which the UI
   * reconstructs from `folder_id`.
   */
  web_view_link?: string
  /**
   * The account the files were written to. Together with `folder_id` it says
   * where `files` live: a Dropbox folder path is the same in every account.
   * Absent on records from before it was written.
   */
  account_email?: string
  files?: CloudFileState[]
  total_size_bytes?: number
  // Legacy single-file layout fields.
  file_id?: string
  file_name?: string
  file_size_bytes?: number
  included_documents?: boolean
  sha256?: string
}

/**
 * Schedule stored under key `google_drive_schedule` / `dropbox_schedule`.
 * Each provider carries its own schedule: a company can back up to Drive
 * nightly and to Dropbox weekly, or leave one of them off entirely. Runs once
 * per day at the configured hour via a cron route
 * (`app/api/extensions/cloud-backup/auto-sync/cron`).
 */
export interface CloudSchedule {
  enabled: boolean
  /**
   * 0-23, UTC hour when the daily auto-sync should run. Legacy field: kept
   * for records written before hour_local existed, and mirrored on writes so
   * old readers keep an approximate value.
   */
  hour_utc: number
  /**
   * 0-23, Europe/Stockholm wall-clock hour. Preferred over hour_utc: it stays
   * put across DST transitions. Absent on records from before this field.
   */
  hour_local?: number
  /**
   * ISO timestamp of when automatic backup was last switched from off to on
   * (PUT /schedule). The card's "nothing saved for two days" warning counts
   * from it. Absent on schedules never switched on by hand since it existed.
   */
  enabled_at?: string | null
  /** ISO timestamp of the last auto-sync attempt (success or failure). */
  last_auto_sync_at: string | null
  /** Outcome of the last auto-sync attempt. */
  last_auto_sync_status: 'success' | 'error' | null
  /** Short error message if the last auto-sync failed. */
  last_auto_sync_error: string | null
  /**
   * Number of auto-sync attempts in a row that failed. Reset to 0 on
   * success; drives the failure-alert email threshold.
   */
  consecutive_failures?: number
  /** ISO timestamp of the last failure-alert email (throttle anchor). */
  last_alert_at?: string | null
  /**
   * The run claim (lib/run-claim.ts): ISO timestamp of when a run, the cron's
   * or a person's, started working on this destination; null or absent when
   * none does. Taken by compare-and-set and cleared when the run ends, so one
   * still set long after is a run the platform ended mid-company.
   */
  sync_started_at?: string | null
  /**
   * Who holds the claim: the hourly cron, or a run a person started ("Synka
   * nu", the first backup after connecting). Only a cron claim nobody
   * released is a nightly backup that died; absent on a claim reads as cron.
   */
  sync_started_by?: 'cron' | 'manual' | null
  /**
   * ISO timestamp of when the cron last ran out of time on this destination
   * with files still to upload. The schedule stays due; this only sends it to
   * the back of the next run's queue.
   */
  deferred_at?: string | null
  /**
   * Due runs in a row that ended at the time budget before reaching this
   * destination. The claim sets it back to 0: it counts waiting, not the
   * runs a large backup needs.
   */
  left_over_runs?: number
  /**
   * ISO timestamp of when the cron last found this destination's claim
   * abandoned and counted the run as failed. One such retry per night.
   */
  interrupted_at?: string | null
}

/** Per-provider status block returned to the UI. */
export interface CloudProviderStatus {
  provider: CloudProviderId
  /**
   * False when the deployment has no OAuth credentials for this provider.
   * The UI renders the row disabled rather than letting the user start a
   * flow that can only fail.
   */
  configured: boolean
  connected: boolean
  /** True when the stored grant cannot work and the user must reconnect. */
  needs_reauth: boolean
  /** Why, when `needs_reauth`; null otherwise. */
  reauth_reason: CloudReauthReason | null
  account_email: string | null
  connected_at: string | null
  last_sync: CloudLastSync | null
  schedule: CloudSchedule | null
}

/**
 * Status returned to the UI. Mirrors the storage shapes above in a
 * shape safe to expose to the client (no encrypted token).
 *
 * The top-level fields describe Google Drive and predate multi-provider
 * support. They are kept so already-deployed clients (and the dashboard
 * health banner) keep working; new code reads `providers`.
 */
export interface CloudBackupStatus {
  providers: CloudProviderStatus[]
  connected: boolean
  needs_reauth: boolean
  account_email: string | null
  connected_at: string | null
  last_sync: CloudLastSync | null
  schedule: CloudSchedule | null
}
