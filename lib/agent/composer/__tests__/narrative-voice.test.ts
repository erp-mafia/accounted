import { describe, it, expect } from 'vitest'
import { fallbackAtomSelection, fallbackNarrative } from '../fallback'
import type { AtomRegistryIndexRow, ComposerInputs } from '../inputs'

// The agent profile narrative has two voices depending on whether the user
// is a verified director at the company:
//
//   - confirmed director  → "Du driver Coredination AB..."
//   - everyone else       → "Coredination AB är..."
//
// The Sonnet path injects this via the system prompt (covered manually in
// system-prompt eval), so these tests target the deterministic fallback:
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
    activeEmployees: null,
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
    // The form is named by its statutory label without an article: Swedish
    // gender agreement ("ett aktiebolag", "en förening") would otherwise
    // need a per-form sentence.
    expect(text).toMatch(/Coredination AB\. Företagsform: Aktiebolag\./)
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
    expect(text).toMatch(/Anna Andersson\. Företagsform: Enskild firma\./)
    expect(text).not.toMatch(/Du driver/)
  })

  it('names an ideell förening by its label instead of calling it an aktiebolag', () => {
    const neutral = fallbackNarrative(
      makeInputs({ entityType: 'ideell_forening', companyName: 'Byalaget', userIsConfirmedDirector: false }),
    )
    expect(neutral).toMatch(/Byalaget\. Företagsform: Ideell förening\./)
    expect(neutral).not.toMatch(/aktiebolag/)
    const director = fallbackNarrative(
      makeInputs({ entityType: 'ideell_forening', companyName: 'Byalaget', userIsConfirmedDirector: true }),
    )
    expect(director).toMatch(/Du driver Byalaget som ideell förening\./)
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
    // Generic neutral form: still no "Du driver".
    expect(text).toMatch(/Coredination AB är ett företag/)
    expect(text).not.toMatch(/Du driver/)
  })
})

// The deterministic selection reads capabilities, never form names: the
// reporting and tax atoms follow what the form files, the owner modifiers
// follow who owns it.
function atom(id: string, tier: AtomRegistryIndexRow['tier']): AtomRegistryIndexRow {
  return { id, tier, title: id, description: '', sni_prefixes: [], trigger_signals: {}, estimated_tokens: 1000, version: 1 }
}

const ATOM_INDEX: AtomRegistryIndexRow[] = [
  atom('horizontal/swedish-vat', 'horizontal'),
  atom('horizontal/swedish-invoice-compliance', 'horizontal'),
  atom('horizontal/swedish-year-end-closing', 'horizontal'),
  atom('horizontal/swedish-accounting-compliance', 'horizontal'),
  atom('horizontal/swedish-sie-import-export', 'horizontal'),
  atom('horizontal/swedish-asset-accounting', 'horizontal'),
  atom('horizontal/swedish-financial-reporting', 'horizontal'),
  atom('horizontal/swedish-sru-filing', 'horizontal'),
  atom('horizontal/swedish-tax-planning', 'horizontal'),
  atom('modifier/single-shareholder-ab-fmb', 'modifier'),
  atom('modifier/enskild-firma', 'modifier'),
]

describe('fallbackAtomSelection by capability', () => {
  it('gives an aktiebolag the årsredovisning, INK2 and tax-planning atoms and the shareholder modifier', () => {
    const sel = fallbackAtomSelection(makeInputs({ entityType: 'aktiebolag', atomIndex: ATOM_INDEX }))
    expect(sel.horizontal_atoms).toEqual(
      expect.arrayContaining([
        'horizontal/swedish-financial-reporting',
        'horizontal/swedish-sru-filing',
        'horizontal/swedish-tax-planning',
      ]),
    )
    expect(sel.modifier_atoms).toEqual(['modifier/single-shareholder-ab-fmb'])
    expect(sel.verification_questions).toContain('Är du ensamägare till företaget?')
  })

  it('gives an enskild firma the EF modifier and none of the AB-only atoms', () => {
    const sel = fallbackAtomSelection(makeInputs({ entityType: 'enskild_firma', atomIndex: ATOM_INDEX }))
    expect(sel.horizontal_atoms).not.toContain('horizontal/swedish-financial-reporting')
    expect(sel.horizontal_atoms).not.toContain('horizontal/swedish-sru-filing')
    expect(sel.horizontal_atoms).not.toContain('horizontal/swedish-tax-planning')
    expect(sel.modifier_atoms).toEqual(['modifier/enskild-firma'])
    expect(sel.verification_questions).not.toContain('Är du ensamägare till företaget?')
  })

  it('gives an ideell förening neither the AB atoms nor the EF modifier', () => {
    const sel = fallbackAtomSelection(makeInputs({ entityType: 'ideell_forening', atomIndex: ATOM_INDEX }))
    expect(sel.horizontal_atoms).toEqual([
      'horizontal/swedish-vat',
      'horizontal/swedish-invoice-compliance',
      'horizontal/swedish-year-end-closing',
      'horizontal/swedish-accounting-compliance',
      'horizontal/swedish-sie-import-export',
      'horizontal/swedish-asset-accounting',
    ])
    expect(sel.modifier_atoms).toEqual([])
    expect(sel.verification_questions).not.toContain('Är du ensamägare till företaget?')
  })

  it('gives an unknown form the universal set only', () => {
    const sel = fallbackAtomSelection(makeInputs({ entityType: 'handelsbolag', atomIndex: ATOM_INDEX }))
    expect(sel.horizontal_atoms).toHaveLength(6)
    expect(sel.modifier_atoms).toEqual([])
  })
})
