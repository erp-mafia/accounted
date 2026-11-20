import {
  INVALID_STORE_URL_CODE,
  STORE_FIREWALL_CODE,
  UNSAFE_STORE_URL_CODE,
  WooCommerceApiError,
} from './api-client'

/**
 * Why a connect-time credential probe (testConnectionAndFetchStoreInfo)
 * failed, and the one thing the merchant should check for each cause.
 *
 * Both connect paths (the wc-auth callback and manual keys) used to answer
 * every failure with the same "check the address and the key" sentence and
 * log only "WooCommerce API 403", so a store behind a firewall looked exactly
 * like a typo'd key, to the merchant and to us (crm#1669).
 */
export type WooProbeFailureKind =
  /** Something in front of WooCommerce refused the request (WAF, security plugin). */
  | 'firewall'
  /** WooCommerce itself refused the keys. */
  | 'credentials'
  /** No wc/v3 REST API at that address. */
  | 'not_found'
  /** The store address answers with a redirect, which is never followed. */
  | 'redirect'
  /** The stored or typed address is not a public https store. */
  | 'store_url'
  /** Network error, timeout or a 5xx from the store. */
  | 'unreachable'
  | 'unknown'

export function classifyProbeFailure(error: unknown): WooProbeFailureKind {
  if (!(error instanceof WooCommerceApiError)) return 'unknown'
  if (error.wooCode === STORE_FIREWALL_CODE) return 'firewall'
  if (error.wooCode === UNSAFE_STORE_URL_CODE) {
    return error.diagnostics.guardReason === 'redirect_blocked' ? 'redirect' : 'store_url'
  }
  if (error.wooCode === INVALID_STORE_URL_CODE) return 'store_url'
  if (error.status === 401 || error.status === 403) return 'credentials'
  if (error.status === 404) return 'not_found'
  if (error.status === 0 || error.status >= 500) return 'unreachable'
  return 'unknown'
}

/** User-facing copy per cause, Swedish first (route `error`) and English (`error_en`). */
const MESSAGES: Record<WooProbeFailureKind, { sv: string; en: string }> = {
  firewall: {
    sv: 'Butikens brandvägg eller ett säkerhetstillägg (till exempel Cloudflare eller Wordfence) stoppade anropet från Accounted innan det nådde WooCommerce. Släpp igenom anrop till /wp-json/wc/v3/ från Accounted (User-Agent Accounted-WooCommerce) och försök igen.',
    en: "The store's firewall or a security plugin (for example Cloudflare or Wordfence) blocked the request from Accounted before it reached WooCommerce. Allow requests to /wp-json/wc/v3/ from Accounted (User-Agent Accounted-WooCommerce) and try again.",
  },
  credentials: {
    sv: 'Butiken godkände inte API-nyckeln. Kontrollera att nyckeln finns kvar i WooCommerce under Inställningar, Avancerat, REST-API och att den har läsbehörighet.',
    en: 'The store did not accept the API key. Check that the key still exists in WooCommerce under Settings, Advanced, REST API and that it has read permission.',
  },
  not_found: {
    sv: 'Hittade inget WooCommerce-API på adressen. Kontrollera butikens adress och att WooCommerce är aktiverat.',
    en: 'No WooCommerce API was found at that address. Check the store address and that WooCommerce is active.',
  },
  redirect: {
    sv: 'Butikens adress skickar vidare till en annan adress. Ange adressen som butiken faktiskt ligger på, till exempel med eller utan www.',
    en: 'The store address redirects to another address. Enter the address the store actually lives at, for example with or without www.',
  },
  store_url: {
    sv: 'Butikens adress gick inte att nå. Ange butikens publika https-adress.',
    en: "The store address could not be reached. Enter the store's public https address.",
  },
  unreachable: {
    sv: 'Butiken svarade inte. Kontrollera att webbplatsen är uppe och försök igen om en stund.',
    en: 'The store did not respond. Check that the site is up and try again in a while.',
  },
  unknown: {
    sv: 'Kunde inte ansluta till butiken med de angivna nycklarna. Kontrollera adressen och att nyckeln har läsbehörighet.',
    en: 'Could not connect to the store with the keys provided. Check the address and that the key has read permission.',
  },
}

export function probeFailureMessage(kind: WooProbeFailureKind): { sv: string; en: string } {
  return MESSAGES[kind]
}

/**
 * Log fields for a failed probe: enough to tell a WAF page from a WooCommerce
 * refusal from a dead host without another round trip to the merchant. Never
 * the keys or the request URL (it carries the keys in query-string mode).
 */
export function probeFailureLogFields(error: unknown): Record<string, unknown> {
  const kind = classifyProbeFailure(error)
  if (!(error instanceof WooCommerceApiError)) {
    return { kind, message: error instanceof Error ? error.message : String(error) }
  }
  return {
    kind,
    message: error.message,
    status: error.status,
    wooCode: error.wooCode,
    ...error.diagnostics,
  }
}
