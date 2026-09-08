import type { EntityType } from '@/types'

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
