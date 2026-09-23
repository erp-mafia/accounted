import { describe, expect, it } from 'vitest'
import { GROUP_LABEL_KEYS, GROUP_ORDER, deriveLibraryCategory, groupForAccount, libraryTemplateGroup } from '../template-groups'
import { getTemplateGroups } from '../booking-templates'
import type { BookingTemplateLibraryLine } from '@/types'

const line = (account: string, type: BookingTemplateLibraryLine['type'] = 'business', side: 'debit' | 'credit' = 'debit'): BookingTemplateLibraryLine =>
  ({ account, label: account, side, type, ratio: 1 }) as BookingTemplateLibraryLine

describe('GROUP_ORDER', () => {
  it('lists every family of the catalog exactly once, with a label key', () => {
    const catalog = getTemplateGroups().map((g) => g.group).sort()
    expect([...GROUP_ORDER].sort()).toEqual(catalog)
    expect(new Set(GROUP_ORDER).size).toBe(GROUP_ORDER.length)
    for (const g of GROUP_ORDER) expect(GROUP_LABEL_KEYS[g]).toMatch(/^group_/)
  })
})

describe('groupForAccount', () => {
  it('files accounts where the static catalog files them', () => {
    expect(groupForAccount('5010')).toBe('premises')
    expect(groupForAccount('5420')).toBe('it_software')
    expect(groupForAccount('5410')).toBe('office_supplies')
    expect(groupForAccount('5611')).toBe('vehicle')
    expect(groupForAccount('5810')).toBe('travel')
    expect(groupForAccount('5910')).toBe('marketing')
    expect(groupForAccount('6071')).toBe('representation')
    expect(groupForAccount('6310')).toBe('insurance')
    expect(groupForAccount('6530')).toBe('professional_services')
    expect(groupForAccount('6570')).toBe('bank_finance')
    expect(groupForAccount('6212')).toBe('telecom')
    expect(groupForAccount('7010')).toBe('personnel')
    expect(groupForAccount('3001')).toBe('revenue')
    expect(groupForAccount('4515')).toBe('goods')
    expect(groupForAccount('8410')).toBe('bank_finance')
    expect(groupForAccount('8910')).toBe('closing')
    expect(groupForAccount('1630')).toBe('tax')
    expect(groupForAccount('2650')).toBe('tax')
    expect(groupForAccount('2018')).toBe('private_transfers')
    expect(groupForAccount('1220')).toBe('equipment')
    expect(groupForAccount('19')).toBeNull()
    expect(groupForAccount(null)).toBeNull()
  })
})

describe('libraryTemplateGroup', () => {
  it('lets the category decide for the families an account cannot', () => {
    expect(libraryTemplateGroup({ category: 'vat', lines: [line('2611'), line('2641'), line('2650')] })).toBe('tax')
    expect(libraryTemplateGroup({ category: 'tax_account', lines: [line('2731'), line('1630', 'settlement', 'credit')] })).toBe('tax')
    expect(libraryTemplateGroup({ category: 'year_end', lines: [line('8811'), line('2110', 'business', 'credit')] })).toBe('closing')
    expect(libraryTemplateGroup({ category: 'private_transfer', lines: [line('2013'), line('1930', 'settlement', 'credit')] })).toBe('private_transfers')
    expect(libraryTemplateGroup({ category: 'salary', lines: [line('7010'), line('1930', 'settlement', 'credit')] })).toBe('personnel')
  })

  it('files the rest by the business account', () => {
    expect(libraryTemplateGroup({ category: 'other', lines: [line('1930', 'settlement', 'credit'), line('5420')] })).toBe('it_software')
    expect(libraryTemplateGroup({ category: 'eu_trade', lines: [line('4535'), line('2614', 'vat', 'credit'), line('2645', 'vat'), line('1930', 'settlement', 'credit')] })).toBe('goods')
    expect(libraryTemplateGroup({ category: 'eu_trade', lines: [line('1510', 'settlement'), line('3308', 'business', 'credit')] })).toBe('revenue')
    expect(libraryTemplateGroup({ category: 'financial', lines: [line('8410'), line('1930', 'settlement', 'credit')] })).toBe('bank_finance')
    expect(libraryTemplateGroup({ category: 'financial', lines: [] })).toBe('bank_finance')
    expect(libraryTemplateGroup({ category: 'other', lines: [] })).toBe('financial')
  })
})

describe('deriveLibraryCategory', () => {
  it('keeps the vat category for a VAT netting, since it routes the entry', () => {
    expect(deriveLibraryCategory([line('2611'), line('2641', 'business', 'credit'), line('2650', 'business', 'credit')])).toBe('vat')
  })

  it('recognises the other historical filings from the accounts', () => {
    expect(deriveLibraryCategory([line('4535'), line('2614', 'vat', 'credit'), line('2645', 'vat'), line('1930', 'settlement', 'credit')])).toBe('eu_trade')
    expect(deriveLibraryCategory([line('2731'), line('1630', 'settlement', 'credit')])).toBe('tax_account')
    expect(deriveLibraryCategory([line('2013'), line('1930', 'settlement', 'credit')])).toBe('private_transfer')
    expect(deriveLibraryCategory([line('7010'), line('2710', 'business', 'credit'), line('1930', 'settlement', 'credit')])).toBe('salary')
    expect(deriveLibraryCategory([line('6072'), line('2641', 'vat'), line('1930', 'settlement', 'credit')])).toBe('representation')
    expect(deriveLibraryCategory([line('8811'), line('2110', 'business', 'credit')])).toBe('year_end')
    expect(deriveLibraryCategory([line('8410'), line('1930', 'settlement', 'credit')])).toBe('financial')
    expect(deriveLibraryCategory([line('5420'), line('2641', 'vat'), line('1930', 'settlement', 'credit')])).toBe('other')
    expect(deriveLibraryCategory([])).toBe('other')
  })
})
