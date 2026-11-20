import { describe, expect, it } from 'vitest'
import { bolagetHubOpen, bolagetTabs } from '../hub'

const keys = (access: { registers: boolean; agreements: boolean }) => bolagetTabs(access).map((t) => t.key)

describe('the Bolaget pages', () => {
  it('has every page for an aktiebolag in the rollout', () => {
    expect(keys({ registers: true, agreements: true })).toEqual(['overview', 'owners', 'board', 'meetings', 'capital', 'owner_tax', 'agreements'])
  })

  it('keeps the per-form rule: a form without an aktiebok sees Översikt and Avtal only', () => {
    expect(keys({ registers: false, agreements: true })).toEqual(['overview', 'agreements'])
  })

  it('has no pages, and no hub, outside the rollout', () => {
    expect(bolagetHubOpen({ registers: false, agreements: false })).toBe(false)
    expect(keys({ registers: false, agreements: false })).toEqual([])
  })
})
