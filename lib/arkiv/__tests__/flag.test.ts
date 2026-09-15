import { describe, it, expect, afterEach } from 'vitest'
import { isArkivEnabled } from '../flag'

describe('isArkivEnabled', () => {
  const saved = process.env.ARKIV_COMPANY_IDS
  afterEach(() => { process.env.ARKIV_COMPANY_IDS = saved })

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
