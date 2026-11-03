/** A consultant who registers time, keyed by initials (Medarbetarkod). */
export interface Consultant {
  code: string
  name: string
}

/** An activity code (arbetskod) with an optional hourly rate in SEK, ex moms. */
export interface ActivityCode {
  code: string
  name: string
  hourly_rate: number | null
}

/** Imported customer code mapped to an Accounted customer. */
export interface CustomerLink {
  code: string
  customer_id: string
}

export interface TimeTrackingSettings {
  consultants: Consultant[]
  activity_codes: ActivityCode[]
  customer_links: CustomerLink[]
  /** Fallback rate when neither the activity code nor the request names one. */
  default_hourly_rate: number | null
}

export const DEFAULT_SETTINGS: TimeTrackingSettings = {
  consultants: [],
  activity_codes: [],
  customer_links: [],
  default_hourly_rate: null,
}

export interface TimeEntry {
  id: string
  company_id: string
  user_id: string
  entry_date: string
  consultant: string
  customer_id: string | null
  customer_code: string | null
  customer_name: string | null
  project_code: string | null
  activity_code: string | null
  hours: number
  comment: string | null
  is_billable: boolean
  invoice_id: string | null
  source: 'manual' | 'import'
  import_key: string | null
  created_at: string
  updated_at: string
}

/** Max hours on one row; mirrors the time_entries CHECK. */
export const MAX_HOURS_PER_ENTRY = 24

/** extension_data.extension_id the time-tracking settings are stored under. */
export const TIME_TRACKING_EXTENSION_ID = 'time-tracking'
