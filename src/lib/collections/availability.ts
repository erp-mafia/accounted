import type { SupabaseClient } from '@supabase/supabase-js'
import type { CollectionsFeatures } from '@accounted/connect-contract'
import { hasCapability } from '@/lib/entitlements/has-capability'
import { CAPABILITY } from '@/lib/entitlements/keys'
import { isSandboxCompany } from '@/lib/sandbox/guard'
import { getCollectionsProvider, type CatalogueDeps, type CatalogueCapabilityEntry } from './catalogue'
import { connectionFacts, loadCollectionObligations, loadLiveConnection } from './connection'
import {
  collectionsStartState,
  hasCollectionObligations,
  isPilotCompany,
  readCollectionsEnv,
  type CollectionsConnectionFacts,
  type CollectionsEnv,
  type CollectionsGateFacts,
  type CollectionsStartState,
} from './flags'
import { chooseCollectionsRoute } from './registry'

/**
 * GET /api/collections/availability: everything the UI needs to decide what
 * to render for collections and delivery, in one read. The UI decides from
 * this alone (build spec 1.8, 3.1).
 */
export interface CollectionsAvailability {
  /** COLLECTIONS_ENABLED on this installation. */
  enabled: boolean
  /** This company is in COLLECTIONS_PILOT_COMPANIES. */
  pilot: boolean
  /** The company holds the paid capability `collections`. */
  capability: boolean
  /** An open case, an unbooked collected payment or an unbooked settlement exists. */
  obligations: boolean
  /** A sandbox company: the fake provider, a "test mode" banner, nothing reaches a customer. */
  sandbox: boolean
  /** Where the start entry points stand (flags.ts collectionsStartState). */
  start: CollectionsStartState
  /** COLLECTIONS_LADDER_ENABLED and COLLECTIONS_DELIVERY_ENABLED. */
  ladderEnabled: boolean
  deliveryEnabled: boolean
  connection: {
    state: CollectionsConnectionFacts['state']
    subStatus: CollectionsConnectionFacts['subStatus']
    health: CollectionsConnectionFacts['health']
    distributionEnabled: boolean
    ladderMode: CollectionsConnectionFacts['ladderMode']
    displayName: string
  } | null
  /** From the catalogue; null when it is unreachable, or not read because nothing would show it. */
  provider: {
    displayName: string
    termsUrl: string | null
    feeSummarySv: string | null
    portalUrl: string | null
    features: CollectionsFeatures
  } | null
  /**
   * The provider's name to show: the catalogue's, else the one stored on the
   * connection row, else null (the UI then says "inkassobolaget").
   */
  displayName: string | null
}

export interface BuildAvailabilityInput {
  env: CollectionsEnv
  facts: CollectionsGateFacts
  sandbox: boolean
  provider: CatalogueCapabilityEntry<CollectionsFeatures> | null
}

export function buildCollectionsAvailability(input: BuildAvailabilityInput): CollectionsAvailability {
  const { env, facts, sandbox, provider } = input
  const connection = facts.connection
  return {
    enabled: env.enabled,
    pilot: isPilotCompany(env, facts.companyId),
    capability: facts.capability,
    obligations: hasCollectionObligations(facts.obligations),
    sandbox,
    start: collectionsStartState(facts, env),
    ladderEnabled: env.ladderEnabled,
    deliveryEnabled: env.deliveryEnabled,
    connection: connection
      ? {
          state: connection.state,
          subStatus: connection.subStatus,
          health: connection.health,
          distributionEnabled: connection.distributionEnabled,
          ladderMode: connection.ladderMode,
          displayName: connection.displayName,
        }
      : null,
    provider: provider
      ? {
          displayName: provider.provider.displayName,
          termsUrl: provider.provider.termsUrl,
          feeSummarySv: provider.provider.feeSummarySv,
          portalUrl: provider.provider.portalUrl,
          features: provider.features,
        }
      : null,
    displayName: provider?.provider.displayName ?? connection?.displayName ?? null,
  }
}

/**
 * The company's collections facts: the paid capability, the live connection
 * row and the work open at the provider (collection_obligation_counts, the
 * same function the database's disconnect guard reads).
 */
export async function loadCollectionsGateFacts(supabase: SupabaseClient, companyId: string): Promise<CollectionsGateFacts> {
  const [capability, connection, obligations] = await Promise.all([
    hasCapability(supabase, companyId, CAPABILITY.collections),
    loadLiveConnection(supabase, companyId),
    loadCollectionObligations(supabase, companyId),
  ])
  return { companyId, capability, connection: connection ? connectionFacts(connection) : null, obligations }
}

export interface AvailabilityDeps extends CatalogueDeps {
  env?: CollectionsEnv
  loadFacts?: (supabase: SupabaseClient, companyId: string) => Promise<CollectionsGateFacts>
  isSandbox?: (supabase: SupabaseClient, companyId: string) => Promise<boolean>
}

export async function getCollectionsAvailability(
  supabase: SupabaseClient,
  companyId: string,
  deps: AvailabilityDeps = {},
): Promise<CollectionsAvailability> {
  const env = deps.env ?? readCollectionsEnv()
  const [facts, sandbox] = await Promise.all([
    (deps.loadFacts ?? loadCollectionsGateFacts)(supabase, companyId),
    (deps.isSandbox ?? isSandboxCompany)(supabase, companyId),
  ])
  // Read the catalogue only when something would show the provider: a dark
  // installation makes no Connect call for this page at all.
  const shown = collectionsStartState(facts, env) !== 'hidden' || hasCollectionObligations(facts.obligations) || facts.connection !== null
  const route = facts.connection?.route ?? chooseCollectionsRoute({ sandbox, fakeAdapterRequested: env.fakeAdapterRequested })
  const provider = shown ? await getCollectionsProvider(route, deps) : null
  return buildCollectionsAvailability({ env, facts, sandbox, provider })
}
