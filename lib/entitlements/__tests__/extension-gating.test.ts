import { describe, it, expect } from 'vitest'
import {
  CAPABILITY,
  EXTENSION_REQUIRED_CAPABILITY,
  requiredCapabilityForExtension,
} from '../keys'

describe('requiredCapabilityForExtension', () => {
  it('gates the invoice-inbox workspace on the AI capability', () => {
    // The inbox exists to run AI field extraction; the sidebar item and the
    // /e/[sector]/[slug] page both read this to hide/block for non-payers.
    expect(requiredCapabilityForExtension('general', 'invoice-inbox')).toBe(CAPABILITY.ai)
  })

  it('returns undefined for extensions that stay open', () => {
    expect(requiredCapabilityForExtension('general', 'enable-banking')).toBeUndefined()
    expect(requiredCapabilityForExtension('general', 'tic')).toBeUndefined()
    expect(requiredCapabilityForExtension('general', 'does-not-exist')).toBeUndefined()
  })

  it('keys the map by `${sector}/${slug}` so page and nav resolve identically', () => {
    expect(EXTENSION_REQUIRED_CAPABILITY['general/invoice-inbox']).toBe(CAPABILITY.ai)
  })
})
