import { SCB_LEGAL_FORM_SOLE_TRADER, type ScbCandidate } from '@/lib/parties/scb/client'
import type { CompanySuggestion } from './types'

/**
 * SCB legal form codes the journey may act on, expressed in the TIC
 * vocabulary `mapSetupEntityType` and `mapPlannedLegalForm` understand: 49
 * (aktiebolag), 10 (enskild näringsidkare) and 61 (ideell förening, which
 * the flag may still refuse at setup) can be set up; 51 (ekonomisk
 * förening), 53 (bostadsrättsförening), 62 (samfällighet) and 71/72
 * (stiftelser) are planned forms the journey stops on. Bank and insurance
 * AB (41, 42) and the rest stay null: the user picks the form, as after a
 * TIC lookup with an unmapped type.
 */
const LEGAL_ENTITY_TYPE_BY_SCB_CODE: Record<string, string> = {
  '49': 'AB',
  [SCB_LEGAL_FORM_SOLE_TRADER]: 'EF',
  '61': 'Ideell förening',
  '51': 'Ekonomisk förening',
  '53': 'Bostadsrättsförening',
  '62': 'Samfällighetsförening',
  '71': 'Familjestiftelse',
  '72': 'Annan stiftelse',
}

export function toCompanySuggestion(c: ScbCandidate): CompanySuggestion {
  return {
    orgNumber: c.orgNumber,
    name: c.name,
    city: c.city,
    legalEntityType: (c.legalFormCode && LEGAL_ENTITY_TYPE_BY_SCB_CODE[c.legalFormCode]) || null,
    active: c.active,
  }
}
