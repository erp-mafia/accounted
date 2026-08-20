import { DEFAULT_CONNECT_BASE_URL } from '../contract'

/**
 * Instance-side connector configuration (a self-hosted deployment).
 *
 *   GNUBOK_CONNECTOR_KEY   the `gnubok_ck_...` key issued for this instance
 *   GNUBOK_CONNECT_URL     hosted origin, default https://app.gnubok.se
 *
 * Unset on hosted and on a self-host without a subscription: then the
 * connector sync is a no-op and the connector capabilities stay gated.
 */
export interface ConnectorConfig {
  key: string
  baseUrl: string
}

export function getConnectorConfig(): ConnectorConfig | null {
  const key = process.env.GNUBOK_CONNECTOR_KEY?.trim()
  if (!key) return null
  const baseUrl = (process.env.GNUBOK_CONNECT_URL?.trim() || DEFAULT_CONNECT_BASE_URL).replace(/\/+$/, '')
  return { key, baseUrl }
}

export function isConnectorConfigured(): boolean {
  return getConnectorConfig() !== null
}
