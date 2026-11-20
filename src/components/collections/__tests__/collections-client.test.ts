import { describe, it, expect } from 'vitest'
import { collectionsErrorMessageFor } from '../collections-client'

describe('collectionsErrorMessageFor', () => {
  it('lower-cases a sentence to sit after "har problem:", but keeps the provider\'s name as written', () => {
    expect(collectionsErrorMessageFor('COLLECTIONS_APPLICATION_NOT_RECEIVED', 'Acme Inkasso')).toBe('ansökan gick inte igenom hos Acme Inkasso. Skicka den igen.')
    expect(collectionsErrorMessageFor('CONNECTOR_UPSTREAM_ERROR', 'Acme Inkasso')).toBe('Acme Inkasso svarade med ett fel. Försök igen om en stund.')
    expect(collectionsErrorMessageFor(null, 'Acme Inkasso')).toBe('')
  })
})
