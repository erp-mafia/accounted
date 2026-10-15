import { describe, expect, it } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import { companyOrgNumber } from '../org-number'

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
