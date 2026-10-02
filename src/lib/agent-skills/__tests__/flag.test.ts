import { afterEach, describe, expect, it, vi } from 'vitest'
import { isAgentsPageEnabled } from '../flag'

afterEach(() => vi.unstubAllEnvs())

describe('isAgentsPageEnabled', () => {
  it('hides the page on Vercel production when no companies are listed', () => {
    vi.stubEnv('AGENTS_PAGE_COMPANY_IDS', '')
    vi.stubEnv('VERCEL_ENV', 'production')
    expect(isAgentsPageEnabled('company-a')).toBe(false)
  })

  it('shows it on previews and locally when no companies are listed', () => {
    vi.stubEnv('AGENTS_PAGE_COMPANY_IDS', '')
    vi.stubEnv('VERCEL_ENV', 'preview')
    expect(isAgentsPageEnabled('company-a')).toBe(true)
    vi.stubEnv('VERCEL_ENV', '')
    expect(isAgentsPageEnabled('company-a')).toBe(true)
  })

  it('shows it to listed companies only, or to everyone with *', () => {
    vi.stubEnv('VERCEL_ENV', 'production')
    vi.stubEnv('AGENTS_PAGE_COMPANY_IDS', 'company-a, company-b')
    expect(isAgentsPageEnabled('company-b')).toBe(true)
    expect(isAgentsPageEnabled('company-c')).toBe(false)
    expect(isAgentsPageEnabled(null)).toBe(false)
    vi.stubEnv('AGENTS_PAGE_COMPANY_IDS', '*')
    expect(isAgentsPageEnabled('company-c')).toBe(true)
  })
})
