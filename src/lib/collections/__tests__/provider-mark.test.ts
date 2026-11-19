import { describe, it, expect } from 'vitest'
import { providerMarkUrl } from '../provider-mark'

describe('providerMarkUrl', () => {
  it('puts the mark beside the catalogue on the connector origin', () => {
    expect(providerMarkUrl('https://connect.example.test', 'acme-inkasso')).toBe('https://connect.example.test/providers/acme-inkasso.svg')
    expect(providerMarkUrl('https://connect.example.test/base/', 'acme')).toBe('https://connect.example.test/base/providers/acme.svg')
  })

  it('encodes the ref, which is opaque', () => {
    expect(providerMarkUrl('https://connect.example.test', 'a b/c')).toBe('https://connect.example.test/providers/a%20b%2Fc.svg')
  })

  it('allows plain http only for a loopback dev server', () => {
    expect(providerMarkUrl('http://127.0.0.1:3420', 'acme')).toBe('http://127.0.0.1:3420/providers/acme.svg')
    expect(providerMarkUrl('http://localhost:3420', 'acme')).toBe('http://localhost:3420/providers/acme.svg')
    expect(providerMarkUrl('http://connect.example.test', 'acme')).toBeNull()
  })

  it('has none without a base, a ref or a valid URL', () => {
    expect(providerMarkUrl(null, 'acme')).toBeNull()
    expect(providerMarkUrl('https://connect.example.test', null)).toBeNull()
    expect(providerMarkUrl('https://connect.example.test', '  ')).toBeNull()
    expect(providerMarkUrl('not a url', 'acme')).toBeNull()
  })
})
