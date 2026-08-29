import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { eventBus } from '@/lib/events/bus'
import {
  captchaTokenOptions,
  getTurnstileRolloutState,
  isTurnstileSubmissionBlocked,
  resolveTurnstileSiteKey,
} from '../turnstile'

const readRepoFile = (file: string) =>
  readFileSync(path.join(process.cwd(), file), 'utf8')

beforeEach(() => {
  vi.clearAllMocks()
  eventBus.clear()
})

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('Turnstile rollout state', () => {
  it('keeps Auth available while the public site key is absent', () => {
    expect(resolveTurnstileSiteKey(undefined)).toBeNull()
    expect(resolveTurnstileSiteKey('')).toBeNull()
    expect(resolveTurnstileSiteKey('   ')).toBeNull()
    expect(getTurnstileRolloutState(undefined)).toBe('disabled')
    expect(isTurnstileSubmissionBlocked(null, undefined)).toBe(false)
  })

  it('treats an unsubstituted Docker sentinel as disabled', () => {
    const sentinel = '__NEXT_PUBLIC_TURNSTILE_SITE_KEY__'
    expect(resolveTurnstileSiteKey(sentinel)).toBeNull()
    expect(getTurnstileRolloutState(sentinel)).toBe('disabled')
    expect(isTurnstileSubmissionBlocked(null, sentinel)).toBe(false)
  })

  it('fails closed after the client site key is configured', () => {
    const siteKey = '  public-site-key  '
    expect(resolveTurnstileSiteKey(siteKey)).toBe('public-site-key')
    expect(getTurnstileRolloutState(siteKey)).toBe('client-enabled')
    expect(isTurnstileSubmissionBlocked(null, siteKey)).toBe(true)
    expect(isTurnstileSubmissionBlocked('', siteKey)).toBe(true)
    expect(isTurnstileSubmissionBlocked('verified-token', siteKey)).toBe(false)
  })

  it('reads the runtime-substituted environment value at call time', () => {
    vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', '')
    expect(getTurnstileRolloutState()).toBe('disabled')

    vi.stubEnv('NEXT_PUBLIC_TURNSTILE_SITE_KEY', 'runtime-site-key')
    expect(getTurnstileRolloutState()).toBe('client-enabled')
  })

  it('forwards only a non-empty token to Supabase Auth', () => {
    expect(captchaTokenOptions(null)).toEqual({})
    expect(captchaTokenOptions(undefined)).toEqual({})
    expect(captchaTokenOptions('   ')).toEqual({})
    expect(captchaTokenOptions('  token-value  ')).toEqual({
      captchaToken: 'token-value',
    })
  })
})

describe('Turnstile integration contract', () => {
  it('protects every public Supabase Auth flow in scope', () => {
    const login = readRepoFile('app/(auth)/login/login-client.tsx')
    const register = readRepoFile('app/(auth)/register/page.tsx')
    const sandbox = readRepoFile('app/sandbox/page.tsx')

    expect(login).toMatch(
      /signInWithPassword\([\s\S]*?options: captchaTokenOptions\(passwordCaptchaToken\)/,
    )
    expect(login).toMatch(
      /resetPasswordForEmail\([\s\S]*?captchaTokenOptions\(resetCaptchaToken\)/,
    )
    expect(login).toContain('action="accounted_login"')
    expect(login).toContain('action="accounted_password_reset"')

    // The register page's email flow moved server-side (invite-only brand
    // domain gate, 2026-08-27): the captcha token must travel to
    // POST /api/auth/signup, and that route must forward it into the GoTrue
    // signUp call, so the CAPTCHA still guards the flow end to end.
    expect(register).toMatch(
      /fetch\('\/api\/auth\/signup'[\s\S]*?captchaTokenOptions\(captchaToken\)/,
    )
    expect(register).toContain('action="accounted_signup"')
    const signupRoute = readRepoFile('app/api/auth/signup/route.ts')
    expect(signupRoute).toMatch(/signUp\(\{[\s\S]*?captchaToken/)

    expect(sandbox).toMatch(
      /signInAnonymously\([\s\S]*?captchaTokenOptions\(captchaToken\)/,
    )
    expect(sandbox).toContain('action="accounted_sandbox"')
  })

  it('keeps the public key, CSP, and Docker runtime contract in sync', () => {
    const envExample = readRepoFile('.env.example')
    const dockerEnvExample = readRepoFile('.env.docker.example')
    const dockerfile = readRepoFile('Dockerfile')
    const entrypoint = readRepoFile('docker-entrypoint.sh')
    const nextConfig = readRepoFile('next.config.ts')

    expect(envExample).toContain('NEXT_PUBLIC_TURNSTILE_SITE_KEY=')
    expect(dockerEnvExample).toContain('NEXT_PUBLIC_TURNSTILE_SITE_KEY=')
    expect(dockerfile).toContain(
      'NEXT_PUBLIC_TURNSTILE_SITE_KEY=__NEXT_PUBLIC_TURNSTILE_SITE_KEY__',
    )
    expect(entrypoint).toContain('__NEXT_PUBLIC_TURNSTILE_SITE_KEY__')
    expect(nextConfig).toContain('https://challenges.cloudflare.com')
    expect(nextConfig).toMatch(/script-src[\s\S]*?turnstileOrigin/)
    expect(nextConfig).toMatch(/frame-src[\s\S]*?turnstileOrigin/)
    expect(envExample).not.toContain('TURNSTILE_SECRET_KEY')
    expect(dockerEnvExample).not.toContain('TURNSTILE_SECRET_KEY')
  })

  it('ships matching Swedish and English challenge messages', () => {
    const swedish = JSON.parse(readRepoFile('messages/sv.json')).auth
    const english = JSON.parse(readRepoFile('messages/en.json')).auth
    const keys = [
      'turnstile_checking',
      'turnstile_required',
      'turnstile_error',
    ]

    for (const key of keys) {
      expect(swedish[key]).toBeTypeOf('string')
      expect(swedish[key]).not.toBe('')
      expect(english[key]).toBeTypeOf('string')
      expect(english[key]).not.toBe('')
    }
  })
})
