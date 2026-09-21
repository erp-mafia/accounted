import type { ComposerInputs } from './inputs'
import type { AtomSelection } from './schemas'
import {
  ENTITY_TYPE_LABELS_SV,
  filesIncomeReturn,
  hasOwners,
  isEntityType,
  preparesArsredovisning,
  supportsCorporateTaxDispositions,
  usesPersonnummerAsOrgNumber,
} from '@/lib/company/entity-type'

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

  // Capabilities, never form names: the reporting and tax atoms follow what
  // the form files, the owner modifiers follow who owns it. An unknown form
  // gets the universal set only.
  const form = isEntityType(inputs.entityType) ? inputs.entityType : null
  const preparesAnnualReport = form !== null && preparesArsredovisning(form)
  const filesInk2 = form !== null && filesIncomeReturn(form) === 'INK2'
  const hasTaxDispositions = form !== null && supportsCorporateTaxDispositions(form)
  // The owner IS the company: an enskild firma.
  const ownerIsTheCompany = form !== null && usesPersonnummerAsOrgNumber(form)
  // Owned by someone other than itself: shareholders (an aktiebolag), not
  // members (a förening) and not the person behind an enskild firma.
  const hasShareholders = form !== null && hasOwners(form) && !usesPersonnummerAsOrgNumber(form)

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
  // SIE and assets are common needs across every form.
  pushIfKnown(horizontal, 'horizontal/swedish-sie-import-export', has)
  pushIfKnown(horizontal, 'horizontal/swedish-asset-accounting', has)

  if (preparesAnnualReport) {
    pushIfKnown(horizontal, 'horizontal/swedish-financial-reporting', has)
  }
  if (filesInk2) {
    pushIfKnown(horizontal, 'horizontal/swedish-sru-filing', has)
  }
  if (hasTaxDispositions) {
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

  // Modifier fallback: pick what we can derive from the form + employer flag.
  const modifiers: string[] = []
  if (hasShareholders) {
    pushIfKnown(modifiers, 'modifier/single-shareholder-ab-fmb', has)
  }
  if (ownerIsTheCompany) {
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
    verification_questions: buildFallbackQuestions(inputs, hasShareholders),
    uncertainty_notes: ['Selection produced by deterministic fallback: Opus call failed or was skipped.'],
  }
}

function pushIfKnown(arr: string[], id: string, has: (id: string) => boolean) {
  if (has(id)) arr.push(id)
}

function buildFallbackQuestions(inputs: ComposerInputs, hasShareholders: boolean): string[] {
  const qs: string[] = []
  if (!inputs.ticSnapshot) {
    qs.push('Vad är din huvudsakliga verksamhet? (några ord räcker)')
  }
  if (hasShareholders) {
    qs.push('Är du ensamägare till företaget?')
    qs.push('Har företaget anställda förutom dig?')
  }
  qs.push('Vilken momsperiod använder ni: månad, kvartal eller år?')
  return qs
}

// Build a minimal Swedish narrative for the fallback path so Phase B has
// something to render even when the Sonnet call also failed. Mirrors the
// Sonnet prompt's voice-branching: second-person only when the user is a
// confirmed director, neutral otherwise. The form is named by its statutory
// label without an article ("Företagsform: Ideell förening."): Swedish
// gender agreement makes a substituted noun inside a sentence wrong.
export function fallbackNarrative(inputs: ComposerInputs): string {
  const parts: string[] = []
  const name = inputs.companyName || 'företaget'
  const label = isEntityType(inputs.entityType) ? ENTITY_TYPE_LABELS_SV[inputs.entityType] : null

  if (inputs.userIsConfirmedDirector) {
    if (label) {
      parts.push(`Du driver ${name} som ${label.toLowerCase()}.`)
    } else {
      parts.push(`Du driver ${name}.`)
    }
  } else {
    if (label) {
      parts.push(`${name}. Företagsform: ${label}.`)
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
