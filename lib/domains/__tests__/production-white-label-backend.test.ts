import { describe, expect, it } from 'vitest'
import { usesForbiddenWhiteLabelBackend } from '../production-white-label-backend'

const STAGING_URL = 'https://metjnjrhvujscngnpzdv.supabase.co'
const THIRD_PROJECT_URL = 'https://qqqqqqqqqqqqqqqqqqqq.supabase.co'
const PRODUCTION_URL = 'https://pwxtzglxptnnvjrpixpg.supabase.co'

// app.gnubok.se is the one entry that the hosted-namespace rule cannot derive:
// it is Accounted's legacy canonical host, live on production today, and it
// only stays protected while it is in the approved inventory.
const APPROVED_PRODUCTION_HOSTS = [
  'acount.accounted.se',
  'amnas.accounted.se',
  'app.gnubok.se',
  'arbore.accounted.se',
  'elma.accounted.se',
  'improveone.accounted.se',
  'm360.accounted.se',
  'redovisningskompaniet.accounted.se',
  'willem.accounted.se',
  'ziffr.accounted.se',
]

describe('production white-label backend guard', () => {
  it.each(APPROVED_PRODUCTION_HOSTS)(
    'blocks %s when it uses the staging project',
    hostname => {
      expect(usesForbiddenWhiteLabelBackend(hostname, STAGING_URL)).toBe(true)
    },
  )

  it.each(APPROVED_PRODUCTION_HOSTS)(
    'serves %s from the production project',
    hostname => {
      expect(usesForbiddenWhiteLabelBackend(hostname, PRODUCTION_URL)).toBe(
        false,
      )
    },
  )

  // The 2026-08-26 incident: a preview build wired to staging answered
  // improveone.accounted.se, a customer host that was not on the protected
  // list. Nothing inside the hosted namespace needs listing any more.
  it.each([
    'app.accounted.se',
    'accounted.se',
    'improveone.accounted.se',
    'notacount.accounted.se',
    'a-byra-that-does-not-exist-yet.accounted.se',
  ])('blocks the unlisted hosted host %s on the staging project', hostname => {
    expect(usesForbiddenWhiteLabelBackend(hostname, STAGING_URL)).toBe(true)
  })

  it('blocks a third project it has never heard of', () => {
    expect(
      usesForbiddenWhiteLabelBackend('willem.accounted.se', THIRD_PROJECT_URL),
    ).toBe(true)
  })

  // Fail closed, not open: an env-less build that reaches updateSession throws
  // straight out of the Web Handler and 500s every path instead.
  it.each([
    undefined,
    '',
    'not a URL',
    '__NEXT_PUBLIC_SUPABASE_URL__',
    'https://pwxtzglxptnnvjrpixpg.supabase.co.attacker.test',
  ])('blocks a production host on the unusable backend %s', url => {
    expect(usesForbiddenWhiteLabelBackend('acount.accounted.se', url)).toBe(
      true,
    )
  })

  it('normalizes case and a trailing dot before the exact host checks', () => {
    expect(
      usesForbiddenWhiteLabelBackend(
        'ACOUNT.ACCOUNTED.SE.',
        'https://METJNJRHVUJSCNGNPZDV.SUPABASE.CO./rest/v1',
      ),
    ).toBe(true)
    expect(
      usesForbiddenWhiteLabelBackend(
        'ACOUNT.ACCOUNTED.SE.',
        'https://PWXTZGLXPTNNVJRPIXPG.SUPABASE.CO./rest/v1',
      ),
    ).toBe(false)
  })

  it.each([
    'erp-base-git-add-white-label-infra.vercel.app',
    'localhost',
    '127.0.0.1',
    '[::1]',
    'app.localhost',
    'accounted.test',
    'acount.accounted.se.attacker.test',
  ])('leaves the preview or local host %s alone', hostname => {
    expect(usesForbiddenWhiteLabelBackend(hostname, STAGING_URL)).toBe(false)
  })

  // A customer that brings its own domain is not derivable from the hosted
  // namespace, so it stays out of scope until it is classified in the approved
  // host inventory. Self-hosted deployments depend on exactly that: their own
  // backend on their own domain has to keep working.
  it('does not classify a domain outside the hosted namespace', () => {
    expect(
      usesForbiddenWhiteLabelBackend('demo.partner-brand.se', STAGING_URL),
    ).toBe(false)
  })
})
