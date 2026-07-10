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
 * Last-sync snapshot stored under key `google_drive_last_sync`.
 */
export interface GoogleDriveLastSync {
  at: string
  file_id: string
  file_name: string
  file_size_bytes: number
  folder_id: string
}

/**
 * Schedule stored under key `google_drive_schedule`. `hour_utc` is 0-23 in UTC;
 * the UI converts to/from the user's local timezone. Runs once per day at that
 * hour via a cron route (`app/api/extensions/cloud-backup/auto-sync/cron`).
 */
export interface GoogleDriveSchedule {
  enabled: boolean
  /** 0-23, UTC hour when the daily auto-sync should run. */
  hour_utc: number
  /** ISO timestamp of the last auto-sync attempt (success or failure). */
  last_auto_sync_at: string | null
  /** Outcome of the last auto-sync attempt. */
  last_auto_sync_status: 'success' | 'error' | null
  /** Short error message if the last auto-sync failed. */
  last_auto_sync_error: string | null
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
