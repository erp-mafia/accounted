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
import type { DigitalMailboxProviderId } from './types'

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

/** Tests: forget the cached providers (and their tokens). */
export function resetDigitalMailboxProviders(): void {
  cached = null
}

/**
 * Kivra and Billo roll out per company, so a deploy with credentials opens
 * them to one company before everyone (founder decision 2026-10-21).
 * DIGITAL_MAILBOX_COMPANY_IDS lists the companies (comma-separated ids, or
 * `*` for everyone); unset means nobody, so credentials alone switch nothing
 * on. A company outside the rollout sees the doors as "Kommer snart" and
 * cannot connect a mailbox or start sending; a connection made before it
 * left the rollout keeps running.
 */
export function digitalMailboxRollout(): 'all' | string[] {
  const raw = process.env.DIGITAL_MAILBOX_COMPANY_IDS?.trim()
  if (!raw) return []
  if (raw === '*') return 'all'
  return [...new Set(raw.split(',').map((s) => s.trim()).filter(Boolean))]
}

/** Whether this company is in the Kivra and Billo rollout. */
export function isDigitalMailboxEnabled(companyId: string | null | undefined): boolean {
  if (!companyId) return false
  const rollout = digitalMailboxRollout()
  return rollout === 'all' || rollout.includes(companyId)
}

export interface DigitalMailboxAvailability {
  receive: boolean
  send: boolean
}

/** What each provider can do for this company: the doors the UI offers. */
export function digitalMailboxAvailability(
  companyId: string | null | undefined,
): Record<DigitalMailboxProviderId, DigitalMailboxAvailability> {
  const providers = getDigitalMailboxProviders()
  const enabled = isDigitalMailboxEnabled(companyId)
  return {
    kivra: { receive: enabled && !!providers.kivra?.receiver, send: enabled && !!providers.kivra?.sender },
    billo: { receive: enabled && !!providers.billo?.receiver, send: enabled && !!providers.billo?.sender },
  }
}
