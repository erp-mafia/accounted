/**
 * The onboarding skill's "which forms can I create" sentence is derived from
 * the legal-form registry at read time, so the text follows the creation
 * flag and names the planned forms as not-yet instead of listing two forms
 * by hand.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { onboardingSkill } from '@/lib/agent-skills/workflows/onboarding'

afterEach(() => vi.unstubAllEnvs())

describe('onboarding skill: supported forms sentence', () => {
  it('lists the creatable forms with their labels and the rest as not yet (flag off)', () => {
    vi.stubEnv('NEXT_PUBLIC_IDEELL_FORENING_ENABLED', '')
    const body = onboardingSkill.body
    expect(body).toContain('`enskild_firma` (Enskild firma)')
    expect(body).toContain('`aktiebolag` (Aktiebolag)')
    expect(body).not.toContain('`ideell_forening`')
    expect(body).toMatch(/Not yet: Ideell förening, Ekonomisk förening, Bostadsrättsförening, Samfällighetsförening, Stiftelse\./)
    expect(body).not.toMatch(/Only `aktiebolag` and `enskild_firma`/)
  })

  it('moves ideell förening into the creatable list when the flag is on', () => {
    vi.stubEnv('NEXT_PUBLIC_IDEELL_FORENING_ENABLED', 'true')
    const body = onboardingSkill.body
    expect(body).toContain('`ideell_forening` (Ideell förening)')
    expect(body).toMatch(/Not yet: Ekonomisk förening, Bostadsrättsförening, Samfällighetsförening, Stiftelse\./)
  })

  it('tells the agent to stop on a not-yet form rather than register another one', () => {
    expect(onboardingSkill.body).toMatch(/never register it as another form/)
  })
})
