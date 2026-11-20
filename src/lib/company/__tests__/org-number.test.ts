import { describe, expect, it } from 'vitest'
import { createTableMockSupabase } from '@/tests/helpers'
import {
  companyIdentityFrom,
  companyOrgNumber,
  companyRedovisare,
  effectiveOrgNumber,
  readCompanyOrgNumber,
  resolveOrgNumberChange,
} from '../org-number'

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

describe('effectiveOrgNumber', () => {
  it('lets the settings copy lead, as written, so a stored century survives', () => {
    expect(effectiveOrgNumber('19800374-0118', '8003740118')).toBe('19800374-0118')
    expect(effectiveOrgNumber(' 556012-5790 ', '2021005489')).toBe('556012-5790')
  })

  it('takes the company copy when the settings hold nothing, an empty string or no number', () => {
    expect(effectiveOrgNumber(null, '5560125790')).toBe('5560125790')
    expect(effectiveOrgNumber(undefined, '5560125790')).toBe('5560125790')
    expect(effectiveOrgNumber('', '5560125790')).toBe('5560125790')
    expect(effectiveOrgNumber('   ', '5560125790')).toBe('5560125790')
    expect(effectiveOrgNumber('saknas', '5560125790')).toBe('5560125790')
  })

  it('an empty company copy hides nothing either', () => {
    expect(effectiveOrgNumber('5560125790', '')).toBe('5560125790')
  })

  it('keeps a value that reads as no number when there is nothing better, so a door can refuse it by name', () => {
    expect(effectiveOrgNumber('12345', null)).toBe('12345')
    expect(effectiveOrgNumber(null, '12345')).toBe('12345')
    expect(effectiveOrgNumber('', '')).toBeNull()
    expect(effectiveOrgNumber(null, null)).toBeNull()
  })
})

describe('readCompanyOrgNumber', () => {
  it('reads the company row only when the settings do not decide it', async () => {
    const decided = createTableMockSupabase({ company_settings: { data: { org_number: '5560125790' }, error: null } })
    expect(await readCompanyOrgNumber(decided.supabase as never, 'co-1')).toBe('5560125790')
    expect(decided.tables()).toEqual(['company_settings'])
  })

  it('does not call a failed read "no number"', async () => {
    const failed = createTableMockSupabase({ company_settings: { data: null, error: { message: 'boom' } } })
    await expect(readCompanyOrgNumber(failed.supabase as never, 'co-1')).rejects.toMatchObject({ message: 'boom' })
    await expect(companyOrgNumber(failed.supabase as never, 'co-1')).rejects.toMatchObject({ message: 'boom' })
  })
})

describe('companyIdentityFrom', () => {
  const rows = (company: { org_number: string | null; entity_type: string }) =>
    createTableMockSupabase({ companies: { data: company, error: null } })

  it('reads no company row when the settings row decides both', async () => {
    const mock = rows({ org_number: '2021005489', entity_type: 'enskild_firma' })
    const identity = await companyIdentityFrom(mock.supabase as never, 'co-1', { org_number: '5560125790', entity_type: 'aktiebolag' })
    expect(identity).toEqual({ orgNumber: '5560125790', entityType: 'aktiebolag' })
    expect(mock.tables()).toEqual([])
  })

  it('lets the company row stand in for a settings row without a number or a form', async () => {
    const mock = rows({ org_number: '556012-5790', entity_type: 'aktiebolag' })
    expect(await companyIdentityFrom(mock.supabase as never, 'co-1', { org_number: '', entity_type: null }))
      .toEqual({ orgNumber: '556012-5790', entityType: 'aktiebolag' })
    expect(await companyIdentityFrom(mock.supabase as never, 'co-1', null))
      .toEqual({ orgNumber: '556012-5790', entityType: 'aktiebolag' })
  })

  it('does not call a failed read "no number"', async () => {
    const failed = createTableMockSupabase({ companies: { data: null, error: { message: 'boom' } } })
    await expect(companyIdentityFrom(failed.supabase as never, 'co-1', null)).rejects.toMatchObject({ message: 'boom' })
  })
})

describe('companyRedovisare', () => {
  const company = (org: string | null, entityType: string) =>
    createTableMockSupabase({
      company_settings: { data: { org_number: org }, error: null },
      companies: { data: { org_number: null, entity_type: entityType }, error: null },
    }).supabase as never

  it('builds the filing identity from the number and the legal form', async () => {
    expect(await companyRedovisare(company('5560125790', 'aktiebolag'), 'co-1')).toBe('165560125790')
    expect(await companyRedovisare(company('800374-0118', 'enskild_firma'), 'co-1')).toBe('198003740118')
    expect(await companyRedovisare(company('198003740118', 'enskild_firma'), 'co-1')).toBe('198003740118')
  })

  it('is null without a number', async () => {
    expect(await companyRedovisare(company(null, 'aktiebolag'), 'co-1')).toBeNull()
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
