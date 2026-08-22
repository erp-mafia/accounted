import { describe, it, expect, vi, beforeEach } from 'vitest'
import { buildFromHeader } from '@/extensions/general/email/lib/resend-service'

vi.mock('@/lib/branding/service', () => ({
  getBranding: () => ({ appName: 'Accounted' }),
}))

// RESEND_FROM_EMAIL is read at module load; the mocked value below is what
// the platform default must render.
vi.hoisted(() => {
  process.env.RESEND_FROM_EMAIL = 'noreply@platform.example'
})

describe('buildFromHeader', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('renders the platform default with the company name "via" the app', () => {
    expect(buildFromHeader({ fromName: 'Hans Bolag AB' })).toBe(
      'Hans Bolag AB via Accounted <noreply@platform.example>',
    )
  })

  it('renders the bare app sender without a company name', () => {
    expect(buildFromHeader({})).toBe('Accounted <noreply@platform.example>')
  })

  it('renders an explicit sender as "<name> <address>" with no "via"', () => {
    expect(
      buildFromHeader({ fromName: 'ignored', from: { name: 'Hans Bolag AB', address: 'faktura@hansbolag.example' } }),
    ).toBe('Hans Bolag AB <faktura@hansbolag.example>')
  })

  it('strips header-injection characters from the explicit name', () => {
    expect(
      buildFromHeader({ from: { name: 'Hans <Bolag>\r\nBcc: x', address: 'faktura@hansbolag.example' } }),
    ).toBe('Hans BolagBcc: x <faktura@hansbolag.example>')
  })

  it('falls back to the platform sender when the explicit address is malformed', () => {
    expect(buildFromHeader({ fromName: 'Hans Bolag AB', from: { name: 'Hans', address: 'not an address' } })).toBe(
      'Hans Bolag AB via Accounted <noreply@platform.example>',
    )
    expect(buildFromHeader({ fromName: 'Hans Bolag AB', from: { name: '   ', address: 'faktura@hansbolag.example' } })).toBe(
      'Hans Bolag AB via Accounted <noreply@platform.example>',
    )
  })
})
