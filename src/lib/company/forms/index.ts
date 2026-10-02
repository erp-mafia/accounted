import type { EntityType } from '@/types'
import type { LegalFormProfile, PlannedLegalForm } from './types'
import { SE_ENSKILD_FIRMA } from './se-enskild-firma'
import { SE_AKTIEBOLAG } from './se-aktiebolag'
import { SE_IDEELL_FORENING } from './se-ideell-forening'
import { SE_EKONOMISK_FORENING } from './se-ekonomisk-forening'

export type { LegalFormProfile, PlannedLegalForm } from './types'

/**
 * The registry. `Record<EntityType, …>` is the one place compile-time
 * exhaustiveness lives: widening `EntityType` does not compile until the new
 * form has a profile. Readers go through lib/company/entity-type.ts, which
 * adds the runtime check for a corrupt string.
 */
export const LEGAL_FORMS: Readonly<Record<EntityType, LegalFormProfile>> = {
  enskild_firma: SE_ENSKILD_FIRMA,
  aktiebolag: SE_AKTIEBOLAG,
  ideell_forening: SE_IDEELL_FORENING,
  ekonomisk_forening: SE_EKONOMISK_FORENING,
}

/**
 * Forms people ask for that are scoped but not creatable. The onboarding
 * picker shows these as a "kommer snart" stop so a treasurer does not pick
 * the nearest supported form and get the wrong equity chart.
 */
export const PLANNED_LEGAL_FORMS: ReadonlyArray<PlannedLegalForm> = [
  { jurisdiction: 'SE', code: 'bostadsrattsforening', label: 'Bostadsrättsförening', reference: '#2666' },
  { jurisdiction: 'SE', code: 'samfallighetsforening', label: 'Samfällighetsförening' },
  { jurisdiction: 'SE', code: 'stiftelse', label: 'Stiftelse', reference: '#2072' },
]
