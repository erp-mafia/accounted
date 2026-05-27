import { describe, it, expect } from 'vitest'
import { fallbackNarrative } from '../fallback'
import type { ComposerInputs } from '../inputs'

// The agent profile narrative has two voices depending on whether the user
// is a verified director at the company:
//
//   - confirmed director  → "Du driver Coredination AB..."
//   - everyone else       → "Coredination AB är..."
//
// The Sonnet path injects this via the system prompt (covered manually in
// system-prompt eval), so these tests target the deterministic fallback —
// which is what ships when Sonnet times out or the API key is missing.
// The fallback is the worst-case render and must never put presumptive
// ownership words in a non-director user's mouth.

function makeInputs(overrides: Partial<ComposerInputs>): ComposerInputs {
  return {
    companyId: 'co-1',
    companyName: 'Coredination AB',
    entityType: 'aktiebolag',
    ticSnapshot: null,
    ticFetchedAt: null,
    companySettings: null,
    sieSummary: null,
    bankingSummary: null,
    atomIndex: [],
    userIsConfirmedDirector: false,
    ...overrides,
  }
}

describe('fallbackNarrative voice branching', () => {
  it('uses second-person "Du driver" when user is a confirmed director', () => {
    const text = fallbackNarrative(makeInputs({ userIsConfirmedDirector: true }))
    expect(text).toMatch(/Du driver Coredination AB som aktiebolag\./)
    expect(text).toMatch(/din verksamhet/i)
  })

  it('uses neutral third-person when user is NOT a confirmed director', () => {
    const text = fallbackNarrative(makeInputs({ userIsConfirmedDirector: false }))
    expect(text).toMatch(/Coredination AB är ett aktiebolag\./)
    // Critical: must not assume the user owns or runs the company.
    expect(text).not.toMatch(/\bDu driver\b/)
    expect(text).not.toMatch(/\bdin verksamhet\b/i)
  })

  it('keeps neutral voice for enskild firma when not confirmed', () => {
    const text = fallbackNarrative(
      makeInputs({
        entityType: 'enskild_firma',
        companyName: 'Anna Andersson',
        userIsConfirmedDirector: false,
      }),
    )
    expect(text).toMatch(/Anna Andersson är en enskild firma\./)
    expect(text).not.toMatch(/Du driver/)
  })

  it('uses second-person for enskild firma when director is confirmed', () => {
    const text = fallbackNarrative(
      makeInputs({
        entityType: 'enskild_firma',
        companyName: 'Anna Andersson',
        userIsConfirmedDirector: true,
      }),
    )
    expect(text).toMatch(/Du driver Anna Andersson som enskild firma\./)
  })

  it('falls back gracefully when entityType is unknown', () => {
    const text = fallbackNarrative(
      makeInputs({
        entityType: 'handelsbolag',
        userIsConfirmedDirector: false,
      }),
    )
    // Generic neutral form — still no "Du driver".
    expect(text).toMatch(/Coredination AB är ett företag/)
    expect(text).not.toMatch(/Du driver/)
  })
})
