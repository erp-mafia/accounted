import { describe, it, expect } from 'vitest'
import { shouldOfferDiscordInvite, type DiscordInviteInputs } from '../discord-invite'

function inputs(overrides: Partial<DiscordInviteInputs> = {}): DiscordInviteInputs {
  return {
    dismissedAt: undefined,
    isSandbox: false,
    isAnonymous: false,
    onBrandHost: false,
    selfHosted: false,
    ...overrides,
  }
}

describe('shouldOfferDiscordInvite', () => {
  it('offers the invite to a hosted user who has not dismissed it', () => {
    expect(shouldOfferDiscordInvite(inputs())).toBe(true)
  })

  it('never offers it again once dismissed or used', () => {
    expect(shouldOfferDiscordInvite(inputs({ dismissedAt: '2026-11-01T08:00:00.000Z' }))).toBe(false)
  })

  it.each([
    ['sandbox', { isSandbox: true }],
    ['anonymous demo', { isAnonymous: true }],
    ['partner brand host', { onBrandHost: true }],
    ['self-hosted', { selfHosted: true }],
  ] as const)('stays hidden for a %s session', (_label, override) => {
    expect(shouldOfferDiscordInvite(inputs(override))).toBe(false)
  })
})
