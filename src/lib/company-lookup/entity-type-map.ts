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
 * company roles. Ekonomisk förening, stiftelse and trossamfund are NOT
 * mapped: different equity, tax form and regelverk.
 */
const IDEELL_FORENING_VALUES = new Set<string>([
  'ideell förening',
  'ideell forening',
  'ideella föreningar',
])

export function mapEntityType(ticType: string | null | undefined): EntityType | null {
  if (!ticType) return null
  const normalized = ticType.trim().toLowerCase()
  if (AKTIEBOLAG_VALUES.has(normalized)) return 'aktiebolag'
  if (ENSKILD_FIRMA_VALUES.has(normalized)) return 'enskild_firma'
  if (IDEELL_FORENING_VALUES.has(normalized)) return 'ideell_forening'
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
  ekonomisk_forening: new Set(['ekonomisk förening', 'ekonomisk forening', 'ekonomiska föreningar']),
  bostadsrattsforening: new Set(['bostadsrättsförening', 'bostadsrattsforening', 'brf']),
  samfallighetsforening: new Set(['samfällighetsförening', 'samfallighetsforening', 'samfällighet']),
  stiftelse: new Set(['stiftelse', 'annan stiftelse', 'familjestiftelse', 'stiftelser']),
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
