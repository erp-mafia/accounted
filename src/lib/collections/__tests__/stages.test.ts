import { describe, expect, it } from 'vitest'
import { collectionsStageSchema } from '@accounted/connect-contract'
import {
  caseKickerKey,
  CHIP_LABEL_KEYS,
  collectionChipKind,
  isInCollectionStage,
  pauseUntilWindow,
  STAGE_LABEL_KEYS,
  START_CASE_ACTIONS,
  WEB_ONLY_CASE_ACTIONS,
} from '../stages'

describe('stages', () => {
  it('reads "Hos inkasso" as an open case past delivery, a registered claim included', () => {
    // A registered claim was handed over for collection: it is "Hos inkasso".
    expect(isInCollectionStage('registered')).toBe(true)
    expect(isInCollectionStage('invoice_sent')).toBe(false)
    expect(isInCollectionStage('closed_paid')).toBe(false)
    for (const stage of ['reminder', 'collection', 'awaiting_decision', 'enforcement', 'payment_plan', 'monitoring', 'paused', 'unknown'] as const) {
      expect(isInCollectionStage(stage)).toBe(true)
    }
  })

  it('gives every open stage a chip and every stage a label', () => {
    for (const stage of collectionsStageSchema.options) {
      expect(STAGE_LABEL_KEYS[stage]).toMatch(/^stage_/)
      const chip = collectionChipKind(stage)
      if (stage === 'closed_paid' || stage === 'closed_other') expect(chip).toBeNull()
      else expect(CHIP_LABEL_KEYS[chip!]).toMatch(/^chip_/)
    }
    expect(collectionChipKind('invoice_sent')).toBe('delivered')
    // A registered claim the provider has not started never reads as sent.
    expect(collectionChipKind('registered')).toBe('registered')
    expect(collectionChipKind('enforcement')).toBe('in_collection')
    expect(collectionChipKind('awaiting_decision')).toBe('decision')
  })

  it('names the card after delivery or collection', () => {
    expect(caseKickerKey('invoice_sent')).toBe('card_kicker_delivery')
    expect(caseKickerKey('reminder')).toBe('card_kicker_collection')
    // A registered claim is a collection case, never "Utskick".
    expect(caseKickerKey('registered')).toBe('card_kicker_collection')
  })

  it('lets a pause run from tomorrow to 14 days ahead, the longest the provider postpones a step', () => {
    expect(pauseUntilWindow('2026-10-06')).toEqual({ earliest: '2026-10-07', latest: '2026-10-20' })
    expect(pauseUntilWindow('2028-02-20')).toEqual({ earliest: '2028-02-21', latest: '2028-03-05' })
  })

  it('treats every start action as web-only', () => {
    for (const action of START_CASE_ACTIONS) expect(WEB_ONLY_CASE_ACTIONS.has(action)).toBe(true)
  })
})
