import 'server-only'

/**
 * Request-scoped brand helpers for SERVER components (WL-12 slice A4).
 *
 * Server components cannot use the client `useBranding()` hook; they resolve
 * the brand from the request Host header instead, exactly like the root
 * layout does. Unknown hosts (the canonical domain included) fall back to
 * `getBranding()` defaults, which keeps default hosts byte-identical.
 *
 * Do NOT import this from client components or from host-less paths
 * (cron, API-key routes): those use `resolveBrandForCompany()` directly.
 */

import { headers } from 'next/headers'
import { getBranding } from './service'
import { normalizeHost, resolveBrandByHost, type Brand } from './resolve'

/**
 * Local dev override (WL-17): host-based resolution can never brand
 * localhost (no brands row exists for it), which made branding untestable in
 * local dev. Setting BRAND_DEV_DOMAIN=<brands.domain> in .env.local makes
 * localhost render that brand. Guarded on the literal local hosts, so the
 * variable can never rebrand a real domain even if it leaks into a deployed
 * environment. UI-only: the middleware home-domain rule still sees the real
 * host, so company partitioning stays un-overridden.
 */
const LOCAL_DEV_HOSTS = new Set(['localhost', '127.0.0.1'])

/** The brand serving the current request, or null on default/unknown hosts. */
export async function resolveRequestBrand(): Promise<Brand | null> {
  const requestHeaders = await headers()
  const host = requestHeaders.get('host')
  if (!host) return null
  const devDomain = process.env.BRAND_DEV_DOMAIN
  if (devDomain && LOCAL_DEV_HOSTS.has(normalizeHost(host))) {
    return resolveBrandByHost(devDomain)
  }
  return resolveBrandByHost(host)
}

/**
 * The app name the current request should display: the request host's brand
 * name when one exists, else the `getBranding()` default. The server-side
 * counterpart of `useBranding().appName`.
 */
export async function getRequestAppName(): Promise<string> {
  const brand = await resolveRequestBrand()
  return brand?.appName ?? getBranding().appName
}
