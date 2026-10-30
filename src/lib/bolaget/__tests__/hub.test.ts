import { describe, expect, it } from 'vitest'
import { activeBolagetTab, bolagetHubOpen, bolagetTabs } from '../hub'

const keys = (access: { registers: boolean; agreements: boolean }) => bolagetTabs(access).map((t) => t.key)

describe('the Bolaget tab bar', () => {
  it('has every tab for an aktiebolag in the rollout', () => {
    expect(keys({ registers: true, agreements: true })).toEqual(['overview', 'owners', 'board', 'meetings', 'capital', 'owner_tax', 'agreements'])
  })

  it('keeps the per-form rule: a form without an aktiebok sees Översikt and Avtal only', () => {
    expect(keys({ registers: false, agreements: true })).toEqual(['overview', 'agreements'])
  })

  it('has no tabs, and no hub, outside the rollout', () => {
    expect(bolagetHubOpen({ registers: false, agreements: false })).toBe(false)
    expect(keys({ registers: false, agreements: false })).toEqual([])
  })

  it('marks the tab of the page, the overview only on /bolaget itself', () => {
    expect(activeBolagetTab('/bolaget')).toBe('overview')
    expect(activeBolagetTab('/bolaget/aktiebok')).toBe('owners')
    expect(activeBolagetTab('/bolaget/agarskatt')).toBe('owner_tax')
    expect(activeBolagetTab('/bolaget/avtal')).toBe('agreements')
    expect(activeBolagetTab('/bolaget/moten/x')).toBe('meetings')
    expect(activeBolagetTab('/bolaget/avtalsrum')).toBeNull()
    expect(activeBolagetTab('/commitments')).toBeNull()
  })
})
