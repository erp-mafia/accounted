/**
 * The sender a signing request shows: the company's own logo and the
 * platform it went out through, the brand's when its team has one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { COMPANY } from './fixtures'

const resolveBrandForCompany = vi.fn()
vi.mock('@/lib/branding/resolve', () => ({ resolveBrandForCompany: (id: string) => resolveBrandForCompany(id) }))

import { signingSenderBrand } from '../brand'

beforeEach(() => {
  vi.clearAllMocks()
  resolveBrandForCompany.mockResolvedValue(null)
})

describe('signingSenderBrand', () => {
  it('answers the company logo and the platform name when the company has no brand', async () => {
    const db = createTableMockSupabase({ company_settings: { data: { logo_url: 'https://cdn.example.test/logo.png' } } })
    expect(await signingSenderBrand(db.supabase as never, COMPANY)).toEqual({ logoUrl: 'https://cdn.example.test/logo.png', platformName: 'Accounted' })
    expect(resolveBrandForCompany).toHaveBeenCalledWith(COMPANY)
  })

  it('answers the brand app name as the platform when the company team has a brand', async () => {
    resolveBrandForCompany.mockResolvedValue({ appName: 'Byrån Ekonomi' })
    const db = createTableMockSupabase({ company_settings: { data: { logo_url: null } } })
    expect(await signingSenderBrand(db.supabase as never, COMPANY)).toEqual({ logoUrl: null, platformName: 'Byrån Ekonomi' })
  })

  it('answers no logo for a missing settings row or a blank logo', async () => {
    const missing = createTableMockSupabase({ company_settings: { data: null } })
    expect((await signingSenderBrand(missing.supabase as never, COMPANY)).logoUrl).toBeNull()
    const blank = createTableMockSupabase({ company_settings: { data: { logo_url: '  ' } } })
    expect((await signingSenderBrand(blank.supabase as never, COMPANY)).logoUrl).toBeNull()
  })
})
