/**
 * The digital mailbox providers this deployment is configured for, built
 * once per process from the environment. A provider without credentials is
 * null, and each direction is null on its own: a deployment with only
 * Kivra's Partner API client receives from Kivra and sends nowhere.
 *
 * The credentials are Accounted's partner agreements with Kivra and Billo,
 * so a self-hosted operator brings their own (or none, and the doors stay
 * hidden).
 */
import { createBilloProvider, readBilloConfigFromEnv, type BilloProvider } from './billo'
import { createKivraProvider, readKivraConfigFromEnv, type KivraProvider } from './kivra'
import type { DigitalMailboxProvider, DigitalMailboxProviderId } from './types'

export interface DigitalMailboxProviders {
  kivra: KivraProvider | null
  billo: BilloProvider | null
}

let cached: DigitalMailboxProviders | null = null

export function buildDigitalMailboxProviders(env: Record<string, string | undefined>): DigitalMailboxProviders {
  const kivra = readKivraConfigFromEnv(env)
  const billo = readBilloConfigFromEnv(env)
  return {
    kivra: kivra ? createKivraProvider(kivra) : null,
    billo: billo ? createBilloProvider(billo) : null,
  }
}

/** The providers from process.env, cached so their token caches live as long as the process. */
export function getDigitalMailboxProviders(): DigitalMailboxProviders {
  if (!cached) cached = buildDigitalMailboxProviders(process.env)
  return cached
}

export function getDigitalMailboxProvider(id: DigitalMailboxProviderId): DigitalMailboxProvider | null {
  return getDigitalMailboxProviders()[id]
}

/** Tests: forget the cached providers (and their tokens). */
export function resetDigitalMailboxProviders(): void {
  cached = null
}

export interface DigitalMailboxAvailability {
  receive: boolean
  send: boolean
}

/** What each provider can do in this deployment: the doors the UI offers. */
export function digitalMailboxAvailability(): Record<DigitalMailboxProviderId, DigitalMailboxAvailability> {
  const providers = getDigitalMailboxProviders()
  return {
    kivra: { receive: !!providers.kivra?.receiver, send: !!providers.kivra?.sender },
    billo: { receive: !!providers.billo?.receiver, send: !!providers.billo?.sender },
  }
}
