import { describe, it, expect } from 'vitest'
import {
  parseZettleOrganizationName,
  zettleStoreDisplayName,
  ZETTLE_DEFAULT_ORGANIZATION_NAME,
  ZETTLE_ORGANIZATION_NAME_MAX_LEN,
} from '../lib/organization-name'

describe('parseZettleOrganizationName', () => {
  it('trims and collapses internal whitespace', () => {
    expect(parseZettleOrganizationName('  Café   Norr  ')).toEqual({
      ok: true,
      name: 'Café Norr',
    })
  })

  it('rejects empty and non-string values', () => {
    expect(parseZettleOrganizationName('').ok).toBe(false)
    expect(parseZettleOrganizationName('   ').ok).toBe(false)
    expect(parseZettleOrganizationName(null).ok).toBe(false)
    expect(parseZettleOrganizationName(1).ok).toBe(false)
  })

  it('rejects names above the max length', () => {
    const tooLong = 'x'.repeat(ZETTLE_ORGANIZATION_NAME_MAX_LEN + 1)
    expect(parseZettleOrganizationName(tooLong).ok).toBe(false)
    expect(
      parseZettleOrganizationName('x'.repeat(ZETTLE_ORGANIZATION_NAME_MAX_LEN)),
    ).toEqual({ ok: true, name: 'x'.repeat(ZETTLE_ORGANIZATION_NAME_MAX_LEN) })
  })

  it('keeps the default connect label short and stable', () => {
    expect(ZETTLE_DEFAULT_ORGANIZATION_NAME).toBe('Zettle')
  })
})

describe('zettleStoreDisplayName', () => {
  it('never falls back to a UUID-shaped string', () => {
    expect(zettleStoreDisplayName(null)).toBe(ZETTLE_DEFAULT_ORGANIZATION_NAME)
    expect(zettleStoreDisplayName('')).toBe(ZETTLE_DEFAULT_ORGANIZATION_NAME)
    expect(zettleStoreDisplayName('  ')).toBe(ZETTLE_DEFAULT_ORGANIZATION_NAME)
    expect(zettleStoreDisplayName('Café Norr')).toBe('Café Norr')
  })
})
