import { describe, it, expect } from 'vitest'
import {
  EXTENSION_REQUIRED_CAPABILITY,
  extensionLockedInSandbox,
  requiredCapabilityForExtension,
} from '../keys'

describe('requiredCapabilityForExtension', () => {
  it('leaves the invoice-inbox workspace open on every plan', () => {
    // The inbox and the Kivra and Billo mailboxes that deliver into it are open
    // on every plan; only the AI reading is gated, where it runs.
    expect(requiredCapabilityForExtension('general', 'invoice-inbox')).toBeUndefined()
    expect(EXTENSION_REQUIRED_CAPABILITY['general/invoice-inbox']).toBeUndefined()
  })

  it('returns undefined for extensions that stay open', () => {
    expect(requiredCapabilityForExtension('general', 'enable-banking')).toBeUndefined()
    expect(requiredCapabilityForExtension('general', 'tic')).toBeUndefined()
    expect(requiredCapabilityForExtension('general', 'does-not-exist')).toBeUndefined()
  })
})

describe('extensionLockedInSandbox', () => {
  it('keeps the inbox locked for the sandbox company although it needs no capability', () => {
    expect(extensionLockedInSandbox('general', 'invoice-inbox')).toBe(true)
  })

  it('leaves every other open extension unlocked', () => {
    expect(extensionLockedInSandbox('general', 'enable-banking')).toBe(false)
    expect(extensionLockedInSandbox('other', 'invoice-inbox')).toBe(false)
    expect(extensionLockedInSandbox('general', 'does-not-exist')).toBe(false)
  })
})
