import { afterEach, describe, expect, it } from 'vitest'
import { inboxHref, inkorgV2Rollout, isInkorgV2Enabled, INKORG_HREF, LEGACY_INBOX_HREF } from '../flag'

const saved = process.env.INKORG_V2_COMPANY_IDS

afterEach(() => {
  if (saved === undefined) delete process.env.INKORG_V2_COMPANY_IDS
  else process.env.INKORG_V2_COMPANY_IDS = saved
})

describe('isInkorgV2Enabled', () => {
  it('is nobody when INKORG_V2_COMPANY_IDS is unset or blank', () => {
    delete process.env.INKORG_V2_COMPANY_IDS
    expect(inkorgV2Rollout()).toEqual([])
    expect(isInkorgV2Enabled('co-1')).toBe(false)
    process.env.INKORG_V2_COMPANY_IDS = '   '
    expect(isInkorgV2Enabled('co-1')).toBe(false)
  })

  it('is the listed companies, each once, ignoring blanks and spaces', () => {
    process.env.INKORG_V2_COMPANY_IDS = ' co-1, ,co-2 ,co-1'
    expect(inkorgV2Rollout()).toEqual(['co-1', 'co-2'])
    expect(isInkorgV2Enabled('co-1')).toBe(true)
    expect(isInkorgV2Enabled('co-2')).toBe(true)
    expect(isInkorgV2Enabled('co-3')).toBe(false)
  })

  it('is everyone for *', () => {
    process.env.INKORG_V2_COMPANY_IDS = '*'
    expect(inkorgV2Rollout()).toBe('all')
    expect(isInkorgV2Enabled('anyone')).toBe(true)
  })

  it('is never on without a company, even for *', () => {
    process.env.INKORG_V2_COMPANY_IDS = '*'
    expect(isInkorgV2Enabled(null)).toBe(false)
    expect(isInkorgV2Enabled(undefined)).toBe(false)
    expect(isInkorgV2Enabled('')).toBe(false)
  })
})

describe('inboxHref', () => {
  it('is the new page in the rollout and the workspace under Inköp outside it', () => {
    expect(inboxHref(true)).toBe(INKORG_HREF)
    expect(inboxHref(true)).toBe('/inkorg')
    expect(inboxHref(false)).toBe(LEGACY_INBOX_HREF)
    expect(inboxHref(false)).toBe('/e/general/invoice-inbox')
  })
})
