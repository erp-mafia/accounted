import { describe, it, expect } from 'vitest'
import { pickNamespaces } from '../root-client-namespaces'

describe('pickNamespaces', () => {
  const messages = {
    auth: { title: 'Logga in', nested: { key: 'x' } },
    common: { save: 'Spara' },
    invoices: { title: 'Fakturor' },
  }

  it('keeps only the named top-level namespaces, by reference', () => {
    const picked = pickNamespaces(messages, ['auth', 'common'])
    expect(picked).toEqual({ auth: messages.auth, common: messages.common })
    expect(picked.auth).toBe(messages.auth)
  })

  it('skips a namespace the catalog does not have', () => {
    expect(pickNamespaces(messages, ['auth', 'missing'])).toEqual({ auth: messages.auth })
  })

  it('does not treat a dotted path or an inherited property as a namespace', () => {
    expect(pickNamespaces(messages, ['auth.nested', 'toString'])).toEqual({})
  })
})
