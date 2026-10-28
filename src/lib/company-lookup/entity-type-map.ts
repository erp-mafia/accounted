import type { EntityType } from '@/types'
import { isEntityTypeCreatable, plannedLegalForms } from '@/lib/company/entity-type'
import type { PlannedLegalForm } from '@/lib/company/forms'

/**
 * Explicit allow-lists for TIC/Bolagsverket `legalEntityType` → Accounted
 * EntityType. Strict (not substring) matching avoids misclassifications like
 * "Enskild stiftelse" → enskild_firma, which would provision with K1/
 * kontantmetoden defaults: an ML/BFL correctness risk.
 *
 * Publikt aktiebolag is included because the bookkeeping regime (K2/K3) and
 * VAT treatment are identical to a privat AB. Specialized AB forms
 * (Bankaktiebolag, Försäkringsaktiebolag) are deliberately excluded: they
 * follow FFFS and need manual setup.
 *
 * Extend only with values whose bookkeeping regime is known to match.
 */
const AKTIEBOLAG_VALUES = new Set<string>([
  'ab',
  'aktiebolag',
  'publikt aktiebolag',
])

const ENSKILD_FIRMA_VALUES = new Set<string>([
  'ef',
  'enskild firma',
  'enskild näringsidkare',
])

/**
 * Ideell förening (issue #2072). Most föreningar carry an 8-series org number
 * issued by Skatteverket, so the Bolagsverket-backed lookup legitimately
 * misses them; this arm matters for the registered ones and for BankID
 * company roles. Stiftelse and trossamfund are not mapped because their
 * equity, tax forms and reporting frameworks differ.
 */
const IDEELL_FORENING_VALUES = new Set<string>([
  'ideell förening',
  'ideell forening',
  'ideella föreningar',
])

const EKONOMISK_FORENING_VALUES = new Set<string>([
  'ekonomisk förening',
  'ekonomisk forening',
  'ekonomiska föreningar',
])

/**
 * Bostadsrättsförening: an ekonomisk förening by law (BRL 1 kap. 2 §) with
 * its own equity, framework (K3 kapitel 38) and filings, so never mapped to
 * ekonomisk_forening. Behind its creation flag the journey stops on it
 * through mapSetupEntityType returning null for it.
 */
const BOSTADSRATTSFORENING_VALUES = new Set<string>([
  'bostadsrättsförening',
  'bostadsrattsforening',
  'brf',
])

export function mapEntityType(ticType: string | null | undefined): EntityType | null {
  if (!ticType) return null
  const normalized = ticType.trim().toLowerCase()
  if (AKTIEBOLAG_VALUES.has(normalized)) return 'aktiebolag'
  if (ENSKILD_FIRMA_VALUES.has(normalized)) return 'enskild_firma'
  if (IDEELL_FORENING_VALUES.has(normalized)) return 'ideell_forening'
  if (EKONOMISK_FORENING_VALUES.has(normalized)) return 'ekonomisk_forening'
  if (BOSTADSRATTSFORENING_VALUES.has(normalized)) return 'bostadsrattsforening'
  return null
}

/**
 * The form a registry lookup may PREFILL for automatic setup: mapEntityType
 * narrowed to forms this deployment can create. A form behind a feature flag
 * maps to null here so the onboarding journey falls through to the form
 * picker (which lists only creatable forms) instead of prefilling a value the
 * create path will refuse at the last step.
 */
export function mapSetupEntityType(ticType: string | null | undefined): EntityType | null {
  const mapped = mapEntityType(ticType)
  return mapped && isEntityTypeCreatable(mapped) ? mapped : null
}

/**
 * Registry spellings of the forms that are scoped but not creatable
 * (lib/company/forms PLANNED_LEGAL_FORMS), keyed by their future code. Same
 * strict matching as above: the journey shows a "stöds inte ännu" stop for
 * these instead of the picker, so a treasurer does not register the nearest
 * supported form and get the wrong equity chart. The bare Swedish names are
 * the Bolagsverket/TIC vocabulary; "Annan stiftelse" and "Familjestiftelse"
 * are TIC's stiftelse categories.
 */
const PLANNED_FORM_VALUES: Readonly<Record<string, ReadonlySet<string>>> = {
  samfallighetsforening: new Set(['samfällighetsförening', 'samfallighetsforening', 'samfällighet']),
  stiftelse: new Set(['stiftelse', 'annan stiftelse', 'familjestiftelse', 'stiftelser']),
  // SCB's legal form 31 names both in one code; it stops as a handelsbolag.
  handelsbolag: new Set(['handelsbolag', 'hb', 'handelsbolag eller kommanditbolag']),
  kommanditbolag: new Set(['kommanditbolag', 'kb']),
}

/** The planned form a registry type names, or null. Never maps a creatable form. */
export function mapPlannedLegalForm(ticType: string | null | undefined): PlannedLegalForm | null {
  if (!ticType) return null
  const normalized = ticType.trim().toLowerCase()
  for (const planned of plannedLegalForms()) {
    if (PLANNED_FORM_VALUES[planned.code]?.has(normalized)) return planned
  }
  return null
}
