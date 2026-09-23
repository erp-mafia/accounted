import { describe, expect, it } from 'vitest'
import { decideHemGate } from '../hem-gate'

const solo = { companyPicked: false, isByraMember: false }

describe('decideHemGate', () => {
  it('renders Hem for an onboarded company', () => {
    expect(decideHemGate({ ...solo, onboardingComplete: true })).toBe('render')
  })

  // The support ticket of 2026-09-19: "when I click Att göra I land on the
  // onboarding again", after a migration reset. The reset used to write
  // onboarding_complete = false on the replacement company, and this gate
  // turned that into a redirect to the create-a-new-company journey. The
  // state is pinned here so the contract stays visible: whoever writes false
  // on an existing company locks its members out of Hem.
  it('sends a company whose flag is false to the journey: the pre-fix migration-reset state', () => {
    expect(decideHemGate({ ...solo, onboardingComplete: false })).toBe('onboarding')
  })

  // The post-fix state: the replacement inherits the source's flag
  // (20260920190800, pinned in tests/pg/company-migration-reset.pg.test.ts),
  // so a company that completed onboarding and was then reset opens Hem. The
  // gate never looks at how much bookkeeping the company holds.
  it('renders Hem for a reset replacement, which inherits onboarded from its source', () => {
    const replacementSettings = { onboarding_complete: true, initial_setup_completed_at: null }
    expect(
      decideHemGate({ ...solo, onboardingComplete: replacementSettings.onboarding_complete }),
    ).toBe('render')
  })

  it('reads a missing settings row or a NULL flag as not onboarded', () => {
    expect(decideHemGate({ ...solo, onboardingComplete: undefined })).toBe('onboarding')
    expect(decideHemGate({ ...solo, onboardingComplete: null })).toBe('onboarding')
  })

  it('sends a byrå member who did not pick the company to the cockpit, not the journey', () => {
    expect(
      decideHemGate({ onboardingComplete: false, companyPicked: false, isByraMember: true }),
    ).toBe('byra')
  })

  it('lets a byrå member who explicitly picked the company reach the journey', () => {
    expect(
      decideHemGate({ onboardingComplete: false, companyPicked: true, isByraMember: true }),
    ).toBe('onboarding')
  })

  it('never diverts an onboarded company, whatever the byrå state', () => {
    expect(
      decideHemGate({ onboardingComplete: true, companyPicked: false, isByraMember: true }),
    ).toBe('render')
  })
})
