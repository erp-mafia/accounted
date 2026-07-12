/**
 * Connection stored per company in extension_data under key
 * `google_drive_connection`. The refresh token is AES-256-GCM encrypted
 * (see lib/crypto.ts): never store it in plaintext.
 */
export interface GoogleDriveConnection {
  refresh_token_encrypted: string
  account_email: string
  connected_at: string
  /** ID of the top-level "gnubok" folder in the user's Drive. */
  root_folder_id: string | null
  /** ID of the per-company subfolder. */
  company_folder_id: string | null
  /**
   * Connection health. `needs_reauth` means Google rejected the refresh
   * token permanently (400 invalid_grant): the cron skips the connection
   * and the UI asks the user to reconnect. Absent/undefined means active
   * (records created before this field existed).
   */
  status?: 'active' | 'needs_reauth'
  /** ISO timestamp of when the dead refresh token was detected. */
  needs_reauth_at?: string
}

/**
 * State of one file in the company's Drive backup folder: an `Arkiv <år>.zip`
 * per räkenskapsår, `Grunddata.zip`, and the folder LÄSMIG.txt. Files are
 * updated in place; `fingerprint` decides whether a sync re-uploads them.
 */
export interface DriveFileState {
  kind: 'period' | 'base' | 'readme'
  /** Set when kind = 'period'. */
  period_id?: string
  file_id: string
  file_name: string
  size_bytes: number
  /** Change-detection key: the file re-uploads only when this differs. */
  fingerprint: string
  /**
   * SHA-256 of the uploaded bytes. The upload itself is verified against
   * Drive's md5Checksum; this hash is recorded for evidentiary value (the
   * user can prove the file in their Drive is the one Accounted produced).
   */
  sha256: string
  /** False when the file was built without document blobs (size fallback). */
  included_documents: boolean
  uploaded_at: string
}

/**
 * Last-sync snapshot stored under key `google_drive_last_sync`.
 *
 * Current records carry `files` (per-fiscal-year layout). The flat
 * `file_id`/`file_name`/`file_size_bytes` fields are the legacy single-ZIP
 * layout, kept optional so old records still render.
 */
export interface GoogleDriveLastSync {
  at: string
  folder_id: string
  files?: DriveFileState[]
  total_size_bytes?: number
  // Legacy single-file layout fields.
  file_id?: string
  file_name?: string
  file_size_bytes?: number
  included_documents?: boolean
  sha256?: string
}

/**
 * Schedule stored under key `google_drive_schedule`. `hour_utc` is 0-23 in UTC;
 * the UI converts to/from the user's local timezone. Runs once per day at that
 * hour via a cron route (`app/api/extensions/cloud-backup/auto-sync/cron`).
 */
export interface GoogleDriveSchedule {
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
}

/**
 * Status returned to the UI. Mirrors the storage shapes above in a
 * shape safe to expose to the client (no encrypted token).
 */
export interface CloudBackupStatus {
  connected: boolean
  /** True when the stored Google refresh token is dead and the user must reconnect. */
  needs_reauth: boolean
  account_email: string | null
  connected_at: string | null
  last_sync: GoogleDriveLastSync | null
  schedule: GoogleDriveSchedule | null
}
