/**
 * Behandlingshistorik: shared types and constants.
 *
 * Kept separate from the generator so client components can import the
 * shapes without pulling the xlsx builder into the browser bundle.
 */

export const BEHANDLINGSHISTORIK_CATEGORIES = [
  'verifikation',
  'kontoplan',
  'installningar',
  'period',
  'import',
  'atkomst',
  'ovrigt',
] as const

export type BehandlingshistorikCategory = (typeof BEHANDLINGSHISTORIK_CATEGORIES)[number]

export type BehandlingshistorikActorType =
  | 'user'
  | 'api_key'
  | 'mcp_oauth'
  | 'cron'
  | 'agent_chat'
  | 'system'

export type BehandlingshistorikSource =
  | 'journal_entries'
  | 'audit_log'
  | 'rattelse_log'
  | 'migration_reset'
  | 'sie_import'
  | 'bank_file_import'

export interface BehandlingshistorikActor {
  type: BehandlingshistorikActorType
  user_id: string | null
  /** Human-readable: e-mail for users, key name for API keys, "Systemet", ... */
  label: string
}

export interface BehandlingshistorikEvent {
  /** Stable per source row, e.g. `audit:<uuid>`, `entry:<uuid>`. */
  id: string
  /** Registreringstidpunkt, ISO 8601 UTC. */
  occurred_at: string
  category: BehandlingshistorikCategory
  /** Stable machine code, e.g. `journal_entry.committed`. */
  code: string
  /** Swedish event label (räkenskapsinformation: stays Swedish in both locales). */
  event: string
  /** What the event concerns: voucher label, account, period name, file name. */
  object: string | null
  actor: BehandlingshistorikActor
  /** Human-readable detail lines (field diffs, counts, reasons). */
  details: string[]
  source: BehandlingshistorikSource
  /** Number of underlying rows this event summarises (burst collapse). */
  count: number
}

export interface BehandlingshistorikReport {
  company: { name: string; org_number: string | null }
  period: { id: string; name: string; start: string; end: string }
  /** Effective window (ISO dates, inclusive). */
  range: { from: string; to: string }
  mode: 'fiscal_year' | 'date_range'
  generated_at: string
  /** Running software version at generation time (BFNAR 2013:2 p. 9.16 second paragraph). */
  app_version: string | null
  total_events: number
  by_category: Record<BehandlingshistorikCategory, number>
  events: BehandlingshistorikEvent[]
  /** Category filter the report was generated with, if any (shown as "Urval" on the document). */
  category_filter?: BehandlingshistorikCategory[] | null
}

/** Swedish category labels for exports and the statutory document. */
export const BEHANDLINGSHISTORIK_CATEGORY_LABELS: Record<BehandlingshistorikCategory, string> = {
  verifikation: 'Verifikationer',
  kontoplan: 'Kontoplan',
  installningar: 'Inställningar',
  period: 'Räkenskapsår',
  import: 'Import',
  atkomst: 'Åtkomst',
  ovrigt: 'Övrigt',
}
