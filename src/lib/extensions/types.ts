import type { SupabaseClient } from '@supabase/supabase-js'
import type { CoreEvent, CoreEventType } from '@/lib/events/types'
import type {
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
  /** Notice shown when enabling: e.g. external subscription requirement */
  subscriptionNotice?: string
}

// ============================================================
// Extension Interface & Supporting Types
// ============================================================

interface ApiRouteBase {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  path: string
}

/**
 * The default route: the dispatcher has authenticated the caller and resolved
 * their active company before the handler runs, so `ctx` is always there.
 * Role gates are declared, not coded: the dispatcher answers 403 before the
 * handler runs, with the same checks withRouteContext makes.
 */
export interface ContextApiRoute extends ApiRouteBase {
  skipAuth?: false
  skipCompanyContext?: false
  /** Refuse viewers (and callers without a membership). */
  requireWrite?: boolean
  /**
   * Refuse everyone but owner and admin, by the database's own predicate
   * (user_is_company_admin). Implies requireWrite.
   */
  requireAdmin?: boolean
  handler: (request: Request, ctx: ExtensionContext) => Promise<Response>
}

/** No auth and no ctx (e.g. OAuth callbacks from external providers). */
export interface PublicApiRoute extends ApiRouteBase {
  skipAuth: true
  skipCompanyContext?: false
  handler: (request: Request) => Promise<Response>
}

/**
 * Auth required but NOT a resolved company context: routes that run during
 * onboarding, before the user has a company (e.g. TIC /lookup used by
 * Step2CompanyDetails while the user types their org number). No ctx.
 */
export interface NoCompanyApiRoute extends ApiRouteBase {
  skipAuth?: false
  skipCompanyContext: true
  handler: (request: Request) => Promise<Response>
}

/** An API route exposed by an extension: exactly one of the three modes. */
export type ApiRouteDefinition = ContextApiRoute | PublicApiRoute | NoCompanyApiRoute

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

/** Core services exposed to extensions */
export interface ExtensionServices {
  ingestTransactions(supabase: SupabaseClient, companyId: string, userId: string, raw: RawTransaction[], options?: IngestOptions): Promise<IngestResult>
}

/** Context passed to extension API route and event handlers */
export interface ExtensionContext {
  userId: string
  companyId: string
  extensionId: string
  /**
   * Stable id for the inbound HTTP request: `req_<uuid>`.
   * Included in the response envelope and in the `X-Request-Id` header so
   * support staff can grep stdout logs by it.
   */
  requestId?: string
  /**
   * True when the caller signed in anonymously (a sandbox demo session). Set
   * by the route dispatcher from the authenticated user, so a route never
   * asks auth again; absent outside an HTTP request.
   */
  isAnonymous?: boolean
  /**
   * In an API route: the caller's client. In an event handler: the
   * service-role client, whichever path emitted the event (lib/extensions/
   * registry.ts), so every query filters by `companyId`.
   */
  supabase: SupabaseClient
  emit(event: CoreEvent): Promise<void>
  settings: ExtensionSettings
  log: ExtensionLogger
  services: ExtensionServices
}

/**
 * Extension interface: the contract for all add-ons.
 *
 * Extensions declare what they provide (API routes, event handlers, services)
 * and the registry wires them into the system.
 */
export interface Extension {
  id: string
  name: string
  version: string
  sector?: SectorSlug

  // Surfaces
  apiRoutes?: ApiRouteDefinition[]
  eventHandlers?: ExtensionEventHandler[]

  /** Named services this extension provides to core via registry lookup */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  services?: Record<string, (...args: any[]) => Promise<any>>
}
