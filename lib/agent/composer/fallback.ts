import type { ComposerInputs } from './inputs'
import type { AtomSelection } from './schemas'

// Deterministic atom selection used when the Opus call times out or fails.
//
// Per plan §7 Phase A: "Fall back to a default vertical from SNI prefix and
// a generic horizontal set (vat, invoice, year-end)". The result is good
// enough that the user can proceed; they can refine atom selection in Phase B
// or rebuild later.
//
// We pick deliberately conservatively: better to load a few extra horizontals
// than to miss one. The agent loop pays for cache, not for content; an extra
// 8k tokens of swedish-financial-reporting on a sole-trader profile is cheap
// noise, while missing swedish-vat on any Swedish company is a correctness bug.
export function fallbackAtomSelection(inputs: ComposerInputs): AtomSelection {
  const knownIds = new Set(inputs.atomIndex.map((a) => a.id))
  const has = (id: string) => knownIds.has(id)

  const isAB = inputs.entityType === 'aktiebolag'
  const isEF = inputs.entityType === 'enskild_firma'

  const tic = inputs.ticSnapshot as
    | {
        registration?: { payroll?: boolean }
        sniCodes?: { code: string; name: string }[]
        employeeRange?: string | null
      }
    | null
  const isEmployer = Boolean(tic?.registration?.payroll)

  const horizontal: string[] = []
  // These three apply to every Swedish business.
  pushIfKnown(horizontal, 'horizontal/swedish-vat', has)
  pushIfKnown(horizontal, 'horizontal/swedish-invoice-compliance', has)
  pushIfKnown(horizontal, 'horizontal/swedish-year-end-closing', has)
  pushIfKnown(horizontal, 'horizontal/swedish-accounting-compliance', has)
  // SIE and assets are common needs across both entity types.
  pushIfKnown(horizontal, 'horizontal/swedish-sie-import-export', has)
  pushIfKnown(horizontal, 'horizontal/swedish-asset-accounting', has)

  if (isAB) {
    pushIfKnown(horizontal, 'horizontal/swedish-financial-reporting', has)
    pushIfKnown(horizontal, 'horizontal/swedish-sru-filing', has)
    pushIfKnown(horizontal, 'horizontal/swedish-tax-planning', has)
  }

  if (isEmployer) {
    pushIfKnown(horizontal, 'horizontal/swedish-payroll', has)
  }

  // Vertical fallback: best-effort SNI-prefix match. Empty list is acceptable:
  // vertical atoms are not yet authored (Phase 3).
  const verticals: string[] = []
  const sniCodes = tic?.sniCodes ?? []
  if (sniCodes.length > 0) {
    for (const atom of inputs.atomIndex) {
      if (atom.tier !== 'vertical') continue
      const matches = sniCodes.some((sni) =>
        atom.sni_prefixes.some((prefix) => sni.code.startsWith(prefix)),
      )
      if (matches) verticals.push(atom.id)
    }
  }

  // Modifier fallback: pick what we can derive from entity_type + employer flag.
  const modifiers: string[] = []
  if (isAB) {
    pushIfKnown(modifiers, 'modifier/single-shareholder-ab-fmb', has)
  }
  if (isEF) {
    pushIfKnown(modifiers, 'modifier/enskild-firma', has)
  }
  if (isEmployer) {
    pushIfKnown(modifiers, 'modifier/small-employer', has)
  }

  return {
    horizontal_atoms: horizontal,
    vertical_atoms: verticals,
    modifier_atoms: modifiers,
    is_multi_vertical: verticals.length > 1,
    verification_questions: buildFallbackQuestions(inputs),
    uncertainty_notes: ['Selection produced by deterministic fallback: Opus call failed or was skipped.'],
  }
}

function pushIfKnown(arr: string[], id: string, has: (id: string) => boolean) {
  if (has(id)) arr.push(id)
}

function buildFallbackQuestions(inputs: ComposerInputs): string[] {
  const qs: string[] = []
  if (!inputs.ticSnapshot) {
    qs.push('Vad är din huvudsakliga verksamhet? (några ord räcker)')
  }
  if (inputs.entityType === 'aktiebolag') {
    qs.push('Är du ensamägare till bolaget?')
    qs.push('Har bolaget anställda förutom dig?')
  }
  qs.push('Vilken momsperiod använder ni: månad, kvartal eller år?')
  return qs
}

// Build a minimal Swedish narrative for the fallback path so Phase B has
// something to render even when the Sonnet call also failed. Mirrors the
// Sonnet prompt's voice-branching: second-person only when the user is a
// confirmed director, neutral otherwise.
export function fallbackNarrative(inputs: ComposerInputs): string {
  const parts: string[] = []
  const name = inputs.companyName || 'företaget'
  const isAB = inputs.entityType === 'aktiebolag'
  const isEF = inputs.entityType === 'enskild_firma'
  const form = isAB ? 'aktiebolag' : isEF ? 'enskild firma' : null

  if (inputs.userIsConfirmedDirector) {
    if (form) {
      parts.push(`Du driver ${name} som ${form}.`)
    } else {
      parts.push(`Du driver ${name}.`)
    }
  } else {
    if (form) {
      parts.push(`${name} är ${form === 'enskild firma' ? 'en enskild firma' : 'ett aktiebolag'}.`)
    } else {
      parts.push(`${name} är ett företag i gnubok.`)
    }
  }
  parts.push(
    'Jag har laddat de svenska reglerna som gäller bredast: moms, fakturering, bokslut och årsavslutning.',
  )
  parts.push(
    inputs.userIsConfirmedDirector
      ? 'Berätta gärna lite mer om din verksamhet i nästa steg så kan jag skräddarsy stöden mer.'
      : 'Berätta gärna lite mer om verksamheten i nästa steg så kan jag skräddarsy stöden mer.',
  )
  return parts.join(' ')
}
