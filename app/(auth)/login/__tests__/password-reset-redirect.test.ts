import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SOURCE = readFileSync(
  fileURLToPath(new URL('../login-client.tsx', import.meta.url)),
  'utf8',
)

describe('password reset redirect wiring', () => {
  it('requests the reset through the server route, never with a browser-built callback', () => {
    // POST /api/auth/password-reset resolves the recovery callback against
    // the brands table from the request host. The browser must not call
    // GoTrue directly with a redirectTo of its own: that is what needed a
    // compiled-in domain list and a redeploy per brand.
    expect(SOURCE).toContain("fetch('/api/auth/password-reset'")
    expect(SOURCE).not.toContain('resetPasswordForEmail(')
    expect(SOURCE).not.toContain('/auth/callback?next=/reset-password')
  })
})
