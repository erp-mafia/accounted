import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const SOURCE = readFileSync(
  fileURLToPath(new URL('../login-client.tsx', import.meta.url)),
  'utf8',
)

describe('password reset redirect wiring', () => {
  it('routes the browser origin through the trusted app-origin resolver', () => {
    expect(SOURCE).toContain('buildPasswordResetRedirectTo(window.location.origin)')
    expect(SOURCE).not.toContain(
      '`${window.location.origin}/auth/callback?next=/reset-password`',
    )
  })
})
