import { describe, it, expect } from 'vitest'
import { CONNECTOR_ERROR_CODES } from '@accounted/connect-contract'
import { getErrorEntry } from '@/lib/errors/structured-errors'
import { ConnectorCallError } from '@/lib/connect/instance/connector-fetch'
import {
  COLLECTIONS_ERROR_MESSAGES,
  CollectionsError,
  collectionsEnvelopeCode,
  collectionsErrorMessage,
  isCollectionsError,
  PROVIDER_FALLBACK_NAME,
  providerDisplayName,
} from '../errors'

describe('collections error words', () => {
  it('fills in the provider, or the neutral word with a capital at the start of a sentence', () => {
    expect(collectionsErrorMessage('CONNECTOR_UNREACHABLE', { provider: 'Acme Inkasso' })).toBe('Kunde inte nå Acme Inkasso just nu. Försök igen om en stund.')
    expect(collectionsErrorMessage('CONNECTOR_COLLECTIONS_DEBTOR_INVALID')).toBe(
      'Inkassobolaget godtog inte kunduppgifterna. Kontrollera adress och person- eller organisationsnummer.',
    )
    expect(collectionsErrorMessage('CONNECTOR_COLLECTIONS_DEBTOR_INVALID', { locale: 'en' })).toMatch(/^The collection agency did not accept/)
  })

  it('answers Peppol-worded and unknown codes under their own collections codes', () => {
    expect(collectionsEnvelopeCode('CONNECTOR_UNREACHABLE')).toBe('COLLECTIONS_CONNECTOR_UNREACHABLE')
    expect(collectionsEnvelopeCode('CONNECTOR_PROTOCOL_ERROR')).toBe('COLLECTIONS_CONNECTOR_PROTOCOL_ERROR')
    expect(collectionsEnvelopeCode('CONNECTOR_SCOPE_MISSING')).toBe('COLLECTIONS_CONNECTOR_SCOPE_MISSING')
    expect(collectionsEnvelopeCode('HTTP_500')).toBe('COLLECTIONS_CONNECTOR_ERROR')
    expect(collectionsEnvelopeCode('CONNECTOR_UPSTREAM_ERROR')).toBe('COLLECTIONS_CONNECTOR_ERROR')
    expect(collectionsEnvelopeCode('CONNECTOR_COLLECTIONS_DUPLICATE_CASE')).toBe('CONNECTOR_COLLECTIONS_DUPLICATE_CASE')
  })

  it('has words for every collections and delivery code of the contract', () => {
    const contractCodes = CONNECTOR_ERROR_CODES.filter(
      (c) => c.startsWith('CONNECTOR_COLLECTIONS_') || c.startsWith('CONNECTOR_DELIVERY_') || c.startsWith('CONNECTOR_IDEMPOTENCY_') ||
        ['CONNECTOR_UPSTREAM_DISABLED', 'CONNECTOR_CONNECTION_NOT_OWNED', 'CONNECTOR_CONTRACT_VERSION_UNSUPPORTED'].includes(c),
    )
    for (const code of contractCodes) expect(COLLECTIONS_ERROR_MESSAGES[code], code).toBeDefined()
  })

  it('registers every envelope code, with the neutral fallback equal to the template', () => {
    for (const [code, template] of Object.entries(COLLECTIONS_ERROR_MESSAGES)) {
      const entry = getErrorEntry(code)
      expect(entry, code).toBeDefined()
      expect(entry!.message_sv, code).toBe(collectionsErrorMessage(code, { locale: 'sv' }))
      expect(entry!.message_en, code).toBe(collectionsErrorMessage(code, { locale: 'en' }))
      // A message that names the provider is composed at throw time.
      expect(Boolean(entry!.thrown_message_sv), code).toBe(template.sv.includes('{provider}'))
    }
  })

  it('picks the provider name from the catalogue, then the connection row, then the neutral word', () => {
    expect(providerDisplayName({ catalogueName: 'A', connectionName: 'B' })).toBe('A')
    expect(providerDisplayName({ catalogueName: ' ', connectionName: 'B' })).toBe('B')
    expect(providerDisplayName({})).toBe(PROVIDER_FALLBACK_NAME.sv)
    expect(providerDisplayName({}, 'en')).toBe(PROVIDER_FALLBACK_NAME.en)
  })

  it('wraps a connector failure without losing its fields', () => {
    const wrapped = CollectionsError.from(new ConnectorCallError('x', { code: 'HTTP_503', retryable: true, detail: 'd', status: 503 }))
    expect(isCollectionsError(wrapped)).toBe(true)
    expect(wrapped).toMatchObject({ code: 'HTTP_503', retryable: true, detail: 'd', status: 503, name: 'CollectionsError' })
    expect(CollectionsError.from(wrapped)).toBe(wrapped)
  })
})
