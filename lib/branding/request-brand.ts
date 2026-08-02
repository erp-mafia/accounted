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
import { resolveBrandByHost, type Brand } from './resolve'

/** The brand serving the current request, or null on default/unknown hosts. */
export async function resolveRequestBrand(): Promise<Brand | null> {
  const requestHeaders = await headers()
  const host = requestHeaders.get('host')
  if (!host) return null
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
