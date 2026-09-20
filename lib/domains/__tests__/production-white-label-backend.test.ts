import { describe, expect, it } from 'vitest'
import { usesForbiddenWhiteLabelBackend } from '../production-white-label-backend'

const STAGING_URL = 'https://metjnjrhvujscngnpzdv.supabase.co'
const THIRD_PROJECT_URL = 'https://qqqqqqqqqqqqqqqqqqqq.supabase.co'
const PRODUCTION_URL = 'https://pwxtzglxptnnvjrpixpg.supabase.co'

// Invented hosts only: this repository is public, so no real customer
// hostname belongs in it. app.gnubok.se is Accounted's own legacy canonical
// host, the one checked-in entry the hosted-namespace rule cannot derive.
const APPROVED_PRODUCTION_HOSTS = [
  'app.accounted.se',
  'app.gnubok.se',
  'brand-a.accounted.se',
  'brand-b.accounted.se',
]

// What PRODUCTION_CUSTOM_DOMAIN_HOSTS carries on the hosted deployment.
const CUSTOM_DOMAIN_HOSTS = 'app.brand-g.se, APP.Brand-H.se. ,'

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
  // a customer host under the namespace that was not on the protected list.
  // Nothing inside the hosted namespace needs listing any more.
  it.each([
    'app.accounted.se',
    'accounted.se',
    'brand-e.accounted.se',
    'notbrand-a.accounted.se',
    'a-byra-that-does-not-exist-yet.accounted.se',
  ])('blocks the unlisted hosted host %s on the staging project', hostname => {
    expect(usesForbiddenWhiteLabelBackend(hostname, STAGING_URL)).toBe(true)
  })

  it('blocks a third project it has never heard of', () => {
    expect(
      usesForbiddenWhiteLabelBackend('brand-c.accounted.se', THIRD_PROJECT_URL),
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
    expect(usesForbiddenWhiteLabelBackend('brand-a.accounted.se', url)).toBe(
      true,
    )
  })

  it('normalizes case and a trailing dot before the exact host checks', () => {
    expect(
      usesForbiddenWhiteLabelBackend(
        'BRAND-A.ACCOUNTED.SE.',
        'https://METJNJRHVUJSCNGNPZDV.SUPABASE.CO./rest/v1',
      ),
    ).toBe(true)
    expect(
      usesForbiddenWhiteLabelBackend(
        'BRAND-A.ACCOUNTED.SE.',
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
    'brand-a.accounted.se.attacker.test',
  ])('leaves the preview or local host %s alone', hostname => {
    expect(usesForbiddenWhiteLabelBackend(hostname, STAGING_URL)).toBe(false)
  })

  // A customer that brings its own domain is not derivable from the hosted
  // namespace, so it stays out of scope until it is classified through
  // PRODUCTION_CUSTOM_DOMAIN_HOSTS. Self-hosted deployments depend on exactly
  // that: their own backend on their own domain has to keep working.
  it('does not classify a domain outside the hosted namespace', () => {
    expect(
      usesForbiddenWhiteLabelBackend('demo.partner-brand.se', STAGING_URL),
    ).toBe(false)
    expect(
      usesForbiddenWhiteLabelBackend(
        'demo.partner-brand.se',
        STAGING_URL,
        CUSTOM_DOMAIN_HOSTS,
      ),
    ).toBe(false)
  })

  it.each(['app.brand-g.se', 'app.brand-h.se', 'APP.BRAND-G.SE.'])(
    'classifies the env-listed custom domain %s as production',
    hostname => {
      expect(
        usesForbiddenWhiteLabelBackend(
          hostname,
          STAGING_URL,
          CUSTOM_DOMAIN_HOSTS,
        ),
      ).toBe(true)
      expect(
        usesForbiddenWhiteLabelBackend(
          hostname,
          PRODUCTION_URL,
          CUSTOM_DOMAIN_HOSTS,
        ),
      ).toBe(false)
    },
  )

  // The cost of moving the list out of the repo: an environment that lacks
  // the var does not know the custom domain exists. Pinned so the trade-off
  // is visible; the var must be set in every hosting environment.
  it.each([undefined, '', ' , '])(
    'leaves a custom domain unclassified when the env value is %s',
    value => {
      expect(
        usesForbiddenWhiteLabelBackend('app.brand-g.se', STAGING_URL, value),
      ).toBe(false)
    },
  )

  it('does not match an env-listed host by suffix', () => {
    expect(
      usesForbiddenWhiteLabelBackend(
        'evil-app.brand-g.se',
        STAGING_URL,
        CUSTOM_DOMAIN_HOSTS,
      ),
    ).toBe(false)
  })
})
