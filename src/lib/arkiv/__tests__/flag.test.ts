import { describe, it, expect, afterEach } from 'vitest'
import { arkivRollout, isArkivEnabled } from '../flag'

const saved = process.env.ARKIV_COMPANY_IDS

afterEach(() => {
  if (saved === undefined) delete process.env.ARKIV_COMPANY_IDS
  else process.env.ARKIV_COMPANY_IDS = saved
})

describe('arkivRollout', () => {
  it('is nobody when unset, everyone for *, and the listed ids otherwise', () => {
    delete process.env.ARKIV_COMPANY_IDS
    expect(arkivRollout()).toEqual([])
    process.env.ARKIV_COMPANY_IDS = '*'
    expect(arkivRollout()).toBe('all')
    process.env.ARKIV_COMPANY_IDS = ' co-1, ,co-2 '
    expect(arkivRollout()).toEqual(['co-1', 'co-2'])
    process.env.ARKIV_COMPANY_IDS = 'co-1,co-2,co-1'
    expect(arkivRollout()).toEqual(['co-1', 'co-2'])
  })
})

describe('isArkivEnabled', () => {
  it('is off for everyone when unset', () => {
    delete process.env.ARKIV_COMPANY_IDS
    expect(isArkivEnabled('co-1')).toBe(false)
  })

  it('lists companies, tolerates spaces, and * means everyone', () => {
    process.env.ARKIV_COMPANY_IDS = ' co-1, co-2 '
    expect(isArkivEnabled('co-1')).toBe(true)
    expect(isArkivEnabled('co-3')).toBe(false)
    expect(isArkivEnabled(null)).toBe(false)
    process.env.ARKIV_COMPANY_IDS = '*'
    expect(isArkivEnabled('anyone')).toBe(true)
  })
})
