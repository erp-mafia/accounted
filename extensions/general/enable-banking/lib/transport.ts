import { getAuthorizationHeader } from './jwt'
import { bankConnectorMode, CONNECTOR_COMPANY_HEADER } from '@/lib/connect/instance/upstreams'

/**
 * Where the Enable Banking client sends its consent, session, account and
 * balance calls, and how it authenticates them.
 *
 * Direct: this installation's own Enable Banking credentials; the JWT is
 * minted here. Connect: the Accounted Connect bank proxy, which speaks the
 * same Enable Banking API, holds the real credentials and mints the JWT on
 * its side; this installation authenticates with its connector key and, on
 * the calls the service meters per company, names the company.
 *
 * The transport is decided once here, at installation level (consents are
 * not per company), from the same configuration the bank feed registry
 * uses. The client never asks "am I in connector mode" itself.
 */
export interface EnableBankingTransport {
  readonly kind: 'direct' | 'connect'
  readonly baseUrl: string
  authorization(): string
  /** Headers naming the company on metered calls; empty on the direct path. */
  companyHeaders(companyId: string | undefined): Record<string, string>
}

// Prefer _PRODUCTION variant; sandbox uses api.tilisy.com, production uses api.enablebanking.com
export const ENABLE_BANKING_API_URL =
  process.env.ENABLE_BANKING_API_URL_PRODUCTION ||
  process.env.ENABLE_BANKING_API_URL ||
  'https://api.enablebanking.com'

const direct: EnableBankingTransport = {
  kind: 'direct',
  baseUrl: ENABLE_BANKING_API_URL,
  authorization: () => getAuthorizationHeader(),
  // An internal company UUID must never reach the real Enable Banking API:
  // a needless behaviour change and an identifier leak to a third-party
  // processor.
  companyHeaders: () => ({}),
}

export function resolveEnableBankingTransport(): EnableBankingTransport {
  const connector = bankConnectorMode()
  if (!connector) return direct
  return {
    kind: 'connect',
    baseUrl: connector.baseUrl,
    authorization: () => `Bearer ${connector.key}`,
    companyHeaders: (companyId) => {
      const headers: Record<string, string> = {}
      if (companyId) headers[CONNECTOR_COMPANY_HEADER] = companyId
      return headers
    },
  }
}
