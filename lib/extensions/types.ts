import type { SupabaseClient } from '@supabase/supabase-js'
import type { CoreEvent, CoreEventType } from '@/lib/events/types'
import type {
  CashAccount,
  EntityType,
  IngestOptions,
  IngestResult,
  RawTransaction,
} from '@/types'

// ============================================================
// Extension Marketplace Types
// ============================================================

/** Extension category for marketplace grouping */
export type ExtensionCategory = 'accounting' | 'reports' | 'import' | 'operations'

/** Sector slugs for extension organization */
export type SectorSlug = 'general'

/** How an extension gets its data */
export type ExtensionDataPattern = 'core' | 'manual' | 'both'

/** Dashboard quick action declared by an extension */
export interface QuickActionDefinition {
  label: string
  description: string
  icon: string
  href?: string
  event?: string
  order?: number
}

/** Extension metadata for the marketplace and workspace routing */
export interface ExtensionDefinition {
  slug: string
  name: string
  sector: SectorSlug
  category: ExtensionCategory
  description: string
  longDescription: string
  icon: string
  entityTypes?: EntityType[]
  dataPattern: ExtensionDataPattern
  readsCoreTables?: string[]
  hasOwnData?: boolean
  quickAction?: QuickActionDefinition
  /** Notice shown when enabling — e.g. external subscription requirement */
  subscriptionNotice?: string
}

/** Sector definition with its extensions */
export interface Sector {
  slug: SectorSlug
  name: string
  icon: string
  description: string
  extensions: ExtensionDefinition[]
}

// ============================================================
// Extension Interface & Supporting Types
// ============================================================

/** A route exposed by an extension (page route) */
export interface RouteDefinition {
  path: string
  label: string
}

/**
 * An API route exposed by an extension.
 *
 * Auth/context modes (mutually exclusive — combining throws at dispatch time):
 *   - default: requires auth AND a resolved company; ctx is passed to the handler
 *   - `skipAuth: true`: no auth, no ctx (e.g. OAuth callbacks)
 *   - `skipCompanyContext: true`: auth required, no ctx (pre-onboarding routes)
 */
export interface ApiRouteDefinition {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  path: string
  /** Skip auth check for this route (e.g. OAuth callbacks from external providers) */
  skipAuth?: boolean
  /**
   * Require auth but NOT a resolved company context. Use for routes that
   * legitimately run during onboarding (before the user has a company) —
   * e.g. TIC /lookup used by Step2CompanyDetails to fetch company info
   * while the user types their org number. Handler is called without a
   * ctx argument; handlers that opt in must tolerate a missing context.
   *
   * Must NOT be combined with `skipAuth: true` — the dispatcher treats
   * that as a misconfiguration and returns 500.
   */
  skipCompanyContext?: boolean
  handler: (request: Request, ctx?: ExtensionContext) => Promise<Response>
}

/** Sidebar navigation item added by an extension */
export interface SidebarItem {
  label: string
  icon?: string
  path: string
  order?: number
}

/** Report type added by an extension */
export interface ReportDefinition {
  id: string
  name: string
  description: string
}

/** Settings panel exposed by an extension */
export interface SettingsPanelDefinition {
  label: string
  path: string
}

/** Tax code definition added by an extension */
export interface TaxCodeDefinition {
  code: string
  rate: number
  description: string
}

/** Dimension type definition added by an extension */
export interface DimensionDefinition {
  id: string
  name: string
  description: string
}

/** Mapping rule type added by an extension */
export interface MappingRuleTypeDefinition {
  id: string
  name: string
  description: string
}

/** Event handler registration for an extension */
export interface ExtensionEventHandler {
  eventType: CoreEventType
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handler: (payload: any, ctx?: ExtensionContext) => Promise<void> | void
}

/** Logger interface for extensions */
export interface ExtensionLogger {
  info(message: string, ...args: unknown[]): void
  warn(message: string, ...args: unknown[]): void
  error(message: string, ...args: unknown[]): void
}

/** Settings accessor for extension-scoped key-value data */
export interface ExtensionSettings {
  get<T>(key?: string): Promise<T | null>
  set<T>(key: string, value: T): Promise<void>
  /**
   * Remove a stored key. Use this to clear state instead of `set(key, null)`,
   * which fails against the `value jsonb NOT NULL` constraint on extension_data.
   * No-op when the key does not exist.
   */
  clear(key: string): Promise<void>
}

/** Storage accessor wrapping Supabase storage */
export interface ExtensionStorage {
  download(bucket: string, path: string): Promise<{ data: Blob | null; error?: string }>
  upload(bucket: string, path: string, data: ArrayBuffer, options?: { contentType?: string }): Promise<{ path: string; error?: string }>
  getPublicUrl(bucket: string, path: string): string
}

/** Core services exposed to extensions */
export interface ExtensionServices {
  ingestTransactions(supabase: SupabaseClient, companyId: string, userId: string, raw: RawTransaction[], options?: IngestOptions): Promise<IngestResult>
  /**
   * List a company's cash accounts (cash_accounts table). Replaces ad-hoc reads
   * of bank_connections.accounts_data for routing decisions. Returns rows
   * sorted by `is_primary DESC, ledger_account ASC`.
   */
  getCashAccounts(supabase: SupabaseClient, companyId: string, opts?: { enabledOnly?: boolean }): Promise<CashAccount[]>
  /**
   * Primary cash account for a company, optionally filtered by currency.
   * Falls back to the global primary when no currency-specific row matches.
   * Used by the skattekonto __PRIMARY_SEK__ sentinel and transfer-pairing.
   */
  getPrimaryCashAccount(supabase: SupabaseClient, companyId: string, currency?: string): Promise<CashAccount | null>
}

/** Context passed to extension lifecycle hooks and event handlers */
export interface ExtensionContext {
  userId: string
  companyId: string
  extensionId: string
  /**
   * Stable id for the inbound HTTP request — `req_<uuid>`.
   * Included in the response envelope and in the `X-Request-Id` header so
   * support staff can grep stdout logs by it.
   */
  requestId?: string
  supabase: SupabaseClient
  emit(event: CoreEvent): Promise<void>
  settings: ExtensionSettings
  storage: ExtensionStorage
  log: ExtensionLogger
  services: ExtensionServices
}

/**
 * Extension interface — the contract for all add-ons.
 *
 * Extensions declare what they provide (routes, event handlers, sidebar items, etc.)
 * and the registry wires them into the system.
 */
export interface Extension {
  id: string
  name: string
  version: string
  sector?: SectorSlug

  // Surfaces
  routes?: RouteDefinition[]
  apiRoutes?: ApiRouteDefinition[]
  sidebarItems?: SidebarItem[]
  eventHandlers?: ExtensionEventHandler[]
  mappingRuleTypes?: MappingRuleTypeDefinition[]
  reportTypes?: ReportDefinition[]
  settingsPanel?: SettingsPanelDefinition
  taxCodes?: TaxCodeDefinition[]
  dimensionTypes?: DimensionDefinition[]

  /** Named services this extension provides to core via registry lookup */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  services?: Record<string, (...args: any[]) => Promise<any>>

  // Lifecycle hooks
  onInstall?(ctx: ExtensionContext): Promise<void>
  onUninstall?(ctx: ExtensionContext): Promise<void>
}
