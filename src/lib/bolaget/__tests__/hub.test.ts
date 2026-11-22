import { describe, expect, it } from 'vitest'
import { bolagetHubOpen, bolagetTabs } from '../hub'

const keys = (access: { registers: boolean; money?: boolean; agreements: boolean }) => bolagetTabs({ money: access.registers, ...access }).map((t) => t.key)

describe('the Bolaget pages', () => {
  it('has every page for an aktiebolag in the rollout', () => {
    expect(keys({ registers: true, agreements: true })).toEqual(['overview', 'owners', 'board', 'meetings', 'capital', 'owner_tax', 'agreements'])
  })

  it('gives a company set up from a formation the registers without the money pages', () => {
    expect(keys({ registers: true, money: false, agreements: false })).toEqual(['overview', 'owners', 'board'])
  })

  it('keeps the per-form rule: a form without an aktiebok sees Översikt and Avtal only', () => {
    expect(keys({ registers: false, agreements: true })).toEqual(['overview', 'agreements'])
  })

  it('has no pages, and no hub, outside the rollout', () => {
    expect(bolagetHubOpen({ registers: false, money: false, agreements: false })).toBe(false)
    expect(keys({ registers: false, agreements: false })).toEqual([])
  })
})
