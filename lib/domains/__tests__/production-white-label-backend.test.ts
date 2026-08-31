import { describe, expect, it } from 'vitest'
import { usesForbiddenWhiteLabelBackend } from '../production-white-label-backend'

const STAGING_URL = 'https://metjnjrhvujscngnpzdv.supabase.co'
const PRODUCTION_URL = 'https://pwxtzglxptnnvjrpixpg.supabase.co'

describe('production white-label backend guard', () => {
  it.each([
    'acount.accounted.se',
    'arbore.accounted.se',
    'elma.accounted.se',
    'm360.accounted.se',
    'redovisningskompaniet.accounted.se',
    'willem.accounted.se',
    'ziffr.accounted.se',
  ])('blocks %s when it uses the staging project', hostname => {
    expect(usesForbiddenWhiteLabelBackend(hostname, STAGING_URL)).toBe(true)
  })

  it('normalizes case and a trailing dot before the exact host checks', () => {
    expect(
      usesForbiddenWhiteLabelBackend(
        'ACOUNT.ACCOUNTED.SE.',
        'https://METJNJRHVUJSCNGNPZDV.SUPABASE.CO./rest/v1',
      ),
    ).toBe(true)
  })

  it.each([
    'app.accounted.se',
    'accounted.se',
    'preview.vercel.app',
    'acount.accounted.se.attacker.test',
    'notacount.accounted.se',
  ])('does not extend the production classification to %s', hostname => {
    expect(usesForbiddenWhiteLabelBackend(hostname, STAGING_URL)).toBe(false)
  })

  it('allows a customer production host to use a different backend', () => {
    expect(
      usesForbiddenWhiteLabelBackend('acount.accounted.se', PRODUCTION_URL),
    ).toBe(false)
  })

  it.each([
    undefined,
    '',
    'not a URL',
    'https://metjnjrhvujscngnpzdv.supabase.co.attacker.test',
  ])('does not mistake an unrecognized backend for the staging project', url => {
    expect(usesForbiddenWhiteLabelBackend('acount.accounted.se', url)).toBe(
      false,
    )
  })
})
