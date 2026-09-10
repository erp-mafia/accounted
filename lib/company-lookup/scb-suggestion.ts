import { SCB_LEGAL_FORM_SOLE_TRADER, type ScbCandidate } from '@/lib/parties/scb/client'
import type { CompanySuggestion } from './types'

/**
 * SCB legal form codes the journey may prefill, expressed in the TIC
 * vocabulary `mapSetupEntityType` already understands: 49 (aktiebolag),
 * 10 (enskild näringsidkare) and 61 (ideell förening, which the flag may
 * still refuse at setup). Bank and insurance AB (41, 42), ekonomisk
 * förening (51), stiftelser and the rest stay null: the user picks the
 * form, as after a TIC lookup with an unmapped type.
 */
const LEGAL_ENTITY_TYPE_BY_SCB_CODE: Record<string, string> = {
  '49': 'AB',
  [SCB_LEGAL_FORM_SOLE_TRADER]: 'EF',
  '61': 'Ideell förening',
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
