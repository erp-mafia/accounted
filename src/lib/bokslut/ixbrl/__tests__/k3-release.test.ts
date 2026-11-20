import { afterEach, describe, expect, it, vi } from 'vitest'
import { k3IxbrlEnabled } from '../k3-release'

afterEach(() => vi.unstubAllEnvs())

describe('k3IxbrlEnabled', () => {
  // The iXBRL document is the K3 årsredovisning in another format: it opens
  // only once the K3 report itself is released, never on its own flag.
  it.each([
    ['', '', false],
    ['true', '', false],
    ['', 'true', false],
    ['true', 'true', true],
  ])('K3 årsredovisning %j and K3 iXBRL %j: %s', (arsredovisning, ixbrl, enabled) => {
    vi.stubEnv('NEXT_PUBLIC_K3_ARSREDOVISNING_ENABLED', arsredovisning)
    vi.stubEnv('NEXT_PUBLIC_K3_IXBRL_ENABLED', ixbrl)
    expect(k3IxbrlEnabled()).toBe(enabled)
  })
})
