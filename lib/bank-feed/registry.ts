import { bankConnectorMode } from '@/lib/connect/instance/upstreams'
import type { BankFeedAdapter } from './port'

/**
 * Bank feed adapter registry and the one place that decides which adapter
 * serves a company.
 *
 * Mirrors the Peppol transport registry (lib/invoices/peppol-transport.ts):
 * adapters register themselves, configuration selects. Nothing else in the
 * ledger may fork on "Connect or direct"; a caller asks
 * `resolveBankFeedAdapter(companyId)` and uses what it gets.
 *
 * Selection, in order:
 *
 * 1. The Connect adapter, when this installation routes bank sync through
 *    Accounted Connect for the company (`bankConnectorMode`: connector key
 *    and no own credentials, or the company is on the per-company canary
 *    list). The installation-level answer (no company) is what consent and
 *    session calls use.
 * 2. Otherwise `BANK_FEED_PROVIDER` when set, which must name a registered
 *    direct adapter.
 * 3. Otherwise the single registered direct adapter. Two direct adapters
 *    without `BANK_FEED_PROVIDER` is a configuration error and resolves to
 *    nothing rather than to a guess.
 *
 * Core registers no adapter of its own: a build with zero extensions has no
 * bank feed and resolves to null, which is the "not dependent on Connect"
 * property made concrete.
 */

export const CONNECT_BANK_FEED_PROVIDER = 'connect'

const adapters = new Map<string, BankFeedAdapter>()

function normalize(provider: string): string {
  return provider.trim().toLowerCase()
}

export function registerBankFeedAdapter(adapter: BankFeedAdapter): () => void {
  const provider = normalize(adapter.provider)
  if (!provider) throw new Error('Bank feed adapter provider is required')
  if (adapters.has(provider)) throw new Error(`Bank feed adapter already registered: ${provider}`)
  adapters.set(provider, adapter)
  return () => {
    if (adapters.get(provider) === adapter) adapters.delete(provider)
  }
}

export function getBankFeedAdapter(provider: string): BankFeedAdapter | null {
  return adapters.get(normalize(provider)) ?? null
}

export function listBankFeedProviders(): string[] {
  return [...adapters.keys()]
}

export type BankFeedResolution =
  | { provider: string; adapter: BankFeedAdapter }
  | { provider: null; adapter: null; reason: 'no_adapter' | 'provider_adapter_unavailable' | 'provider_selection_required' }

export function resolveBankFeed(companyId?: string): BankFeedResolution {
  if (bankConnectorMode(companyId)) {
    const connect = adapters.get(CONNECT_BANK_FEED_PROVIDER)
    if (connect) return { provider: CONNECT_BANK_FEED_PROVIDER, adapter: connect }
    return { provider: null, adapter: null, reason: 'provider_adapter_unavailable' }
  }

  const direct = [...adapters.keys()].filter((p) => p !== CONNECT_BANK_FEED_PROVIDER)
  const configured = process.env.BANK_FEED_PROVIDER?.trim().toLowerCase()
  if (configured) {
    const adapter = configured === CONNECT_BANK_FEED_PROVIDER ? null : adapters.get(configured)
    if (!adapter) return { provider: null, adapter: null, reason: 'provider_adapter_unavailable' }
    return { provider: configured, adapter }
  }
  if (direct.length === 1) return { provider: direct[0], adapter: adapters.get(direct[0])! }
  if (direct.length === 0) return { provider: null, adapter: null, reason: 'no_adapter' }
  return { provider: null, adapter: null, reason: 'provider_selection_required' }
}

/** The adapter that serves this company, or null when none is configured. */
export function resolveBankFeedAdapter(companyId?: string): BankFeedAdapter | null {
  return resolveBankFeed(companyId).adapter
}

/** Test hook: forget every registered adapter. */
export function __resetBankFeedRegistryForTests(): void {
  adapters.clear()
}
