import { describe, expect, it } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { companyOrgNumber, resolveOrgNumberChange } from '../org-number'

function stored(settings: string | null | undefined, company?: string | null) {
  return createTableMockSupabase({
    company_settings: { data: settings === undefined ? null : { org_number: settings }, error: null },
    companies: { data: company === undefined ? null : { org_number: company }, error: null },
  }).supabase as never
}

describe('companyOrgNumber', () => {
  it('reads a legal entity\'s number as ten digits, with or without its separator or 16 prefix', async () => {
    expect(await companyOrgNumber(stored('5595386219'), 'co-1')).toBe('5595386219')
    expect(await companyOrgNumber(stored('559538-6219'), 'co-1')).toBe('5595386219')
    expect(await companyOrgNumber(stored('165595386219'), 'co-1')).toBe('5595386219')
    expect(await companyOrgNumber(stored('16559538-6219'), 'co-1')).toBe('5595386219')
  })

  it('reads an enskild firma\'s personnummer stored with its century (19 or 20) as the ten digits the bank has', async () => {
    expect(await companyOrgNumber(stored('191212121212'), 'co-1')).toBe('1212121212')
    expect(await companyOrgNumber(stored('19121212-1212'), 'co-1')).toBe('1212121212')
    expect(await companyOrgNumber(stored('201212121212'), 'co-1')).toBe('1212121212')
    expect(await companyOrgNumber(stored('121212-1212'), 'co-1')).toBe('1212121212')
  })

  it('refuses what is no organisationsnummer: too short, a VAT number, another century, letters', async () => {
    expect(await companyOrgNumber(stored('12345'), 'co-1')).toBeNull()
    expect(await companyOrgNumber(stored('11223344556'), 'co-1')).toBeNull()
    // 559538621901 is the number plus "01": its last ten digits are somebody else's identity.
    expect(await companyOrgNumber(stored('559538621901'), 'co-1')).toBeNull()
    expect(await companyOrgNumber(stored('991212121212'), 'co-1')).toBeNull()
    expect(await companyOrgNumber(stored('SE5595386219'), 'co-1')).toBeNull()
    expect(await companyOrgNumber(stored('saknas'), 'co-1')).toBeNull()
  })

  it('takes the company row when the settings hold none or one that does not read as a number', async () => {
    expect(await companyOrgNumber(stored(undefined, '559538-6219'), 'co-1')).toBe('5595386219')
    expect(await companyOrgNumber(stored('', '5595386219'), 'co-1')).toBe('5595386219')
    expect(await companyOrgNumber(stored('12345', '191212121212'), 'co-1')).toBe('1212121212')
    // A usable settings value leads.
    expect(await companyOrgNumber(stored('5595386219', '5560125790'), 'co-1')).toBe('5595386219')
  })

  it('is null when neither row has one', async () => {
    expect(await companyOrgNumber(stored(undefined), 'co-1')).toBeNull()
    expect(await companyOrgNumber(stored(null, null), 'co-1')).toBeNull()
    expect(await companyOrgNumber(stored('', ''), 'co-1')).toBeNull()
  })
})

describe('resolveOrgNumberChange', () => {
  function companyRow(org: string | null, entityType = 'aktiebolag') {
    return createTableMockSupabase({ companies: { data: { org_number: org, entity_type: entityType }, error: null } })
  }

  it('decides from the settings copy alone when it is valid or unchanged, without reading the company row', async () => {
    const mock = companyRow(null)
    expect(await resolveOrgNumberChange(mock.supabase as never, 'co-1', '2021005489', { org_number: '5560125790' }))
      .toEqual({ kind: 'refused', code: 'SETTINGS_ORG_NUMBER_LOCKED' })
    expect(await resolveOrgNumberChange(mock.supabase as never, 'co-1', 'saknas', { org_number: 'saknas' }))
      .toEqual({ kind: 'unchanged' })
    expect(mock.tables()).toEqual([])
  })

  it('reads the company row when the settings copy is empty or invalid: its valid number locks too', async () => {
    const mock = companyRow('556012-5790')
    expect(await resolveOrgNumberChange(mock.supabase as never, 'co-1', '2021005489', { org_number: '' }))
      .toEqual({ kind: 'refused', code: 'SETTINGS_ORG_NUMBER_LOCKED' })
    expect(mock.tables()).toEqual(['companies'])
  })

  it('fills in when neither copy is valid, checked against the company row\'s legal form when the settings have none', async () => {
    expect(await resolveOrgNumberChange(companyRow(null).supabase as never, 'co-1', '556012-5790', { org_number: null }))
      .toEqual({ kind: 'fill', value: '5560125790' })
    expect(await resolveOrgNumberChange(companyRow('', 'enskild_firma').supabase as never, 'co-1', '556012-5790', { org_number: null, entity_type: null }))
      .toEqual({ kind: 'refused', code: 'SETTINGS_ORG_NUMBER_PERSONNUMMER_REQUIRED' })
  })

  it('fails closed when the company row cannot be read', async () => {
    const mock = createTableMockSupabase({ companies: { data: null, error: { message: 'boom' } } })
    expect(await resolveOrgNumberChange(mock.supabase as never, 'co-1', '5560125790', { org_number: '' }))
      .toEqual({ kind: 'error', error: { message: 'boom' } })
  })
})
