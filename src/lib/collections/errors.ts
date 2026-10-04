import {
  ConnectorCallError,
  CONNECTOR_PROTOCOL_ERROR_CODE,
  CONNECTOR_UNREACHABLE_CODE,
} from '@/lib/connect/instance/connector-fetch'

/**
 * Errors of the collections and delivery ports, and the words they are shown
 * with.
 *
 * Every adapter (the Connect adapter and the fake) throws CollectionsError
 * with a stable `code`: a contract code from the service's envelope, one of
 * the adapter codes in lib/connect/instance/connector-fetch.ts, or one of the
 * ledger's own codes below. `detail` is the service's prose, for logs only.
 *
 * The provider is never named in code: user-facing text says `{provider}`,
 * which the caller fills from the catalogue's displayName, then the name
 * persisted on the company's connection row, then the neutral word
 * (PROVIDER_FALLBACK_NAME).
 */
export class CollectionsError extends ConnectorCallError {
  constructor(
    message: string,
    options: { code: string; retryable: boolean; detail?: string | null; status?: number | null; cause?: unknown },
  ) {
    super(message, options)
    this.name = 'CollectionsError'
  }

  static from(error: ConnectorCallError): CollectionsError {
    if (error instanceof CollectionsError) return error
    return new CollectionsError(error.message, {
      code: error.code,
      retryable: error.retryable,
      detail: error.detail,
      status: error.status,
      cause: error,
    })
  }
}

export function isCollectionsError(error: unknown): error is CollectionsError {
  return error instanceof CollectionsError
}

/** Start work is switched off for this company (kill switch, pilot list, ladder or delivery flag). */
export const COLLECTIONS_DISABLED = 'COLLECTIONS_DISABLED'
/** Start work needs an active connection (and, for delivery and the batch, the company's opt-in). */
export const COLLECTIONS_NOT_ACTIVE = 'COLLECTIONS_NOT_ACTIVE'
/** The connection's route has no adapter on this installation (route 'connect' without a connector key). */
export const COLLECTIONS_UNAVAILABLE = 'COLLECTIONS_UNAVAILABLE'
/** The fake adapter has no such case, delivery or settlement. */
export const COLLECTIONS_NOT_FOUND = 'COLLECTIONS_NOT_FOUND'

/** The neutral word used when neither the catalogue nor the connection row names the provider. */
export const PROVIDER_FALLBACK_NAME = { sv: 'inkassobolaget', en: 'the collection agency' } as const

export type CollectionsLocale = 'sv' | 'en'

/**
 * The name to show for the provider: the catalogue's displayName, else the
 * name stored on the connection at activation, else the neutral word.
 */
export function providerDisplayName(
  sources: { catalogueName?: string | null; connectionName?: string | null },
  locale: CollectionsLocale = 'sv',
): string {
  const name = sources.catalogueName?.trim() || sources.connectionName?.trim()
  return name || PROVIDER_FALLBACK_NAME[locale]
}

/**
 * Codes that already carry a fixed, Peppol-worded message in the structured
 * error registry (lib/errors/structured-errors.ts). A collections or delivery
 * failure is answered under its own code instead, so the user never reads a
 * Peppol sentence about a debt collection case.
 */
const ENVELOPE_CODE_ALIASES: Readonly<Record<string, string>> = {
  [CONNECTOR_UNREACHABLE_CODE]: 'COLLECTIONS_CONNECTOR_UNREACHABLE',
  [CONNECTOR_PROTOCOL_ERROR_CODE]: 'COLLECTIONS_CONNECTOR_PROTOCOL_ERROR',
  CONNECTOR_SCOPE_MISSING: 'COLLECTIONS_CONNECTOR_SCOPE_MISSING',
  CONNECTOR_RATE_LIMITED: 'COLLECTIONS_CONNECTOR_RATE_LIMITED',
}

/** Bilingual templates; `{provider}` is replaced by providerDisplayName(). */
export const COLLECTIONS_ERROR_MESSAGES: Readonly<Record<string, { sv: string; en: string }>> = {
  COLLECTIONS_DISABLED: {
    sv: 'Inkasso är inte tillgängligt just nu.',
    en: 'Debt collection is not available right now.',
  },
  COLLECTIONS_NOT_ACTIVE: {
    sv: 'Aktivera inkasso och utskick först.',
    en: 'Activate debt collection and delivery first.',
  },
  COLLECTIONS_UNAVAILABLE: {
    sv: 'Kopplingen till {provider} är inte konfigurerad i den här miljön.',
    en: 'The connection to {provider} is not configured in this environment.',
  },
  COLLECTIONS_NOT_FOUND: {
    sv: 'Ärendet finns inte hos {provider}.',
    en: '{provider} has no such case.',
  },
  COLLECTIONS_CONNECTOR_UNREACHABLE: {
    sv: 'Kunde inte nå {provider} just nu. Försök igen om en stund.',
    en: 'Could not reach {provider} right now. Try again shortly.',
  },
  COLLECTIONS_CONNECTOR_PROTOCOL_ERROR: {
    sv: 'Svaret från {provider} kunde inte tolkas. Kontakta support om felet kvarstår.',
    en: 'The answer from {provider} could not be read. Contact support if the problem persists.',
  },
  COLLECTIONS_CONNECTOR_SCOPE_MISSING: {
    sv: 'Kopplingsnyckeln saknar behörighet för inkasso och utskick. Kontakta support.',
    en: 'The connector key lacks permission for debt collection and delivery. Contact support.',
  },
  COLLECTIONS_CONNECTOR_RATE_LIMITED: {
    sv: 'För många anrop till {provider} på kort tid. Vänta en stund och försök igen.',
    en: 'Too many calls to {provider} in a short time. Wait a moment and try again.',
  },
  COLLECTIONS_CONNECTOR_ERROR: {
    sv: '{provider} svarade med ett fel. Försök igen om en stund.',
    en: '{provider} answered with an error. Try again shortly.',
  },
  CONNECTOR_UPSTREAM_DISABLED: {
    sv: 'Tjänsten är tillfälligt avstängd.',
    en: 'The service is temporarily switched off.',
  },
  CONNECTOR_IDEMPOTENCY_IN_FLIGHT: {
    sv: 'Förfrågan behandlas redan. Försök igen om en stund.',
    en: 'The request is already being processed. Try again shortly.',
  },
  CONNECTOR_IDEMPOTENCY_MISMATCH: {
    sv: 'En tidigare förfrågan med samma nyckel innehöll andra uppgifter, så inget skickades. Kontakta support.',
    en: 'An earlier request with the same key carried different data, so nothing was sent. Contact support.',
  },
  CONNECTOR_CONTRACT_VERSION_UNSUPPORTED: {
    sv: 'Den här versionen av Accounted är för gammal för kopplingstjänsten. Uppdatera installationen.',
    en: 'This version of Accounted is too old for the connector service. Update the installation.',
  },
  CONNECTOR_CONNECTION_NOT_OWNED: {
    sv: 'Kopplingen till {provider} hör inte till det här företaget. Kontakta support.',
    en: 'The connection to {provider} does not belong to this company. Contact support.',
  },
  CONNECTOR_COLLECTIONS_NOT_ONBOARDED: {
    sv: 'Företaget är inte anslutet till {provider} ännu.',
    en: 'The company is not connected to {provider} yet.',
  },
  CONNECTOR_COLLECTIONS_NOT_APPROVED: {
    sv: '{provider} har inte godkänt företaget ännu.',
    en: '{provider} has not approved the company yet.',
  },
  CONNECTOR_COLLECTIONS_CASE_NOT_OWNED: {
    sv: 'Ärendet hör inte till det här företaget hos {provider}.',
    en: 'The case does not belong to this company at {provider}.',
  },
  CONNECTOR_COLLECTIONS_ACTION_UNAVAILABLE: {
    sv: 'Det går inte att göra det i ärendets nuvarande läge.',
    en: 'That is not possible in the case\'s current state.',
  },
  CONNECTOR_COLLECTIONS_DEBTOR_INVALID: {
    sv: '{provider} godtog inte kunduppgifterna. Kontrollera adress och person- eller organisationsnummer.',
    en: '{provider} did not accept the customer details. Check the address and the personal identity or organisation number.',
  },
  CONNECTOR_COLLECTIONS_DUPLICATE_CASE: {
    sv: '{provider} har redan ett öppet ärende för fakturan.',
    en: '{provider} already has an open case for the invoice.',
  },
  CONNECTOR_COLLECTIONS_AMOUNT_INVALID: {
    sv: '{provider} godtog inte beloppet.',
    en: '{provider} did not accept the amount.',
  },
  CONNECTOR_DELIVERY_METHOD_UNAVAILABLE: {
    sv: 'Utskickssättet är inte tillgängligt för den här kunden.',
    en: 'The delivery method is not available for this customer.',
  },
  CONNECTOR_DELIVERY_DOCUMENT_REJECTED: {
    sv: '{provider} godtog inte fakturans PDF.',
    en: '{provider} did not accept the invoice PDF.',
  },
}

/**
 * The code a collections or delivery failure is answered under in the API
 * envelope: the contract code when the registry words it for this context,
 * an alias where the registry's wording belongs to Peppol, and
 * COLLECTIONS_CONNECTOR_ERROR for anything else (an HTTP status, an upstream
 * code no message is written for).
 */
export function collectionsEnvelopeCode(code: string): string {
  if (ENVELOPE_CODE_ALIASES[code]) return ENVELOPE_CODE_ALIASES[code]
  if (COLLECTIONS_ERROR_MESSAGES[code]) return code
  return 'COLLECTIONS_CONNECTOR_ERROR'
}

/** The user-facing sentence for a code, with the provider's name filled in. */
export function collectionsErrorMessage(
  code: string,
  options: { provider?: string | null; locale?: CollectionsLocale } = {},
): string {
  const locale = options.locale ?? 'sv'
  const template = COLLECTIONS_ERROR_MESSAGES[collectionsEnvelopeCode(code)]
  const provider = options.provider?.trim() || PROVIDER_FALLBACK_NAME[locale]
  const text = template[locale].replaceAll('{provider}', provider)
  // A sentence that starts with the provider's name keeps its own casing; the
  // neutral word is lower case and needs a capital at the start of a sentence.
  return text.charAt(0).toUpperCase() + text.slice(1)
}
