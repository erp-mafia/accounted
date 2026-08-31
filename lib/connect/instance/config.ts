import { DEFAULT_CONNECT_BASE_URL } from '../contract'
import { createLogger } from '@/lib/logger'

const log = createLogger('connect/config')

/**
 * Instance-side connector configuration (a self-hosted deployment).
 *
 *   GNUBOK_CONNECTOR_KEY   the `gnubok_ck_...` key issued for this instance
 *   GNUBOK_CONNECT_URL     hosted origin, default https://app.gnubok.se
 *
 * Unset on hosted and on a self-host without a subscription: then the
 * connector sync is a no-op and the connector capabilities stay gated.
 *
 * GNUBOK_CONNECT_URL must be https: the hourly sync sends the long-lived
 * connector key as a Bearer header to this origin, so an http:// typo would
 * ship the credential in plaintext. Plain http is allowed only for loopback
 * hosts (local development against a dev server). An invalid or non-https
 * URL disables the connector entirely (fail closed, nothing is sent).
 */
export interface ConnectorConfig {
  key: string
  baseUrl: string
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

export function getConnectorConfig(): ConnectorConfig | null {
  const key = process.env.GNUBOK_CONNECTOR_KEY?.trim()
  if (!key) return null
  const raw = (process.env.GNUBOK_CONNECT_URL?.trim() || DEFAULT_CONNECT_BASE_URL).replace(/\/+$/, '')
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    log.warn('GNUBOK_CONNECT_URL is not a valid URL; connector disabled', { value: raw })
    return null
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname) || LOOPBACK_HOSTS.has(`[${url.hostname}]`)
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    log.warn('GNUBOK_CONNECT_URL must be https (http only for loopback); connector disabled', {
      protocol: url.protocol,
      host: url.hostname,
    })
    return null
  }
  return { key, baseUrl: raw }
}

export function isConnectorConfigured(): boolean {
  return getConnectorConfig() !== null
}
