import { describe, expect, it } from 'vitest'
import { isStandardBASAccount } from '@/lib/bookkeeping/bas-reference'
import {
  DEFAULT_POS_SALES_SETTINGS,
  applyPosSalesSettingsPatch,
  posSalesSettingsPatchSchema,
  posSalesSettingsSchema,
  resolvePosSalesSettings,
} from '../settings'

describe('POS sales settings', () => {
  it('defaults to BAS 2026 accounts that exist in the catalogue', () => {
    expect(posSalesSettingsSchema.safeParse(DEFAULT_POS_SALES_SETTINGS).success).toBe(true)
    const named = [
      ...Object.values(DEFAULT_POS_SALES_SETTINGS.tender_accounts),
      ...Object.values(DEFAULT_POS_SALES_SETTINGS.revenue_accounts),
      ...Object.values(DEFAULT_POS_SALES_SETTINGS.vat_accounts),
      DEFAULT_POS_SALES_SETTINGS.tips_account,
      DEFAULT_POS_SALES_SETTINGS.rounding_account,
    ].filter((a): a is string => a !== null)
    for (const account of named) expect(isStandardBASAccount(account), account).toBe(true)
    // Card and Swish clear on 1686, never straight to revenue or the bank.
    expect(DEFAULT_POS_SALES_SETTINGS.tender_accounts.card).toBe('1686')
    expect(DEFAULT_POS_SALES_SETTINGS.tender_accounts.swish).toBe('1686')
    // Only a person knows whether a VAT-free sale is a gift card or exempt.
    expect(DEFAULT_POS_SALES_SETTINGS.revenue_accounts['0']).toBeNull()
  })

  it('merges a stored map over the defaults key by key', () => {
    const resolved = resolvePosSalesSettings({ tender_accounts: { swish: '1930' }, tips_account: '2829' })
    expect(resolved.tender_accounts).toEqual({ ...DEFAULT_POS_SALES_SETTINGS.tender_accounts, swish: '1930' })
    expect(resolved.tips_account).toBe('2829')
    expect(resolved.vat_accounts).toEqual(DEFAULT_POS_SALES_SETTINGS.vat_accounts)
  })

  it('falls back to the default for a stored value that no longer validates', () => {
    const resolved = resolvePosSalesSettings({
      tender_accounts: { card: 1686, cash: 'kassa' },
      rounding_account: '37',
      max_rounding: 500,
    })
    expect(resolved.tender_accounts.card).toBe('1686')
    expect(resolved.tender_accounts.cash).toBe('1910')
    expect(resolved.rounding_account).toBe('3740')
    expect(resolved.max_rounding).toBe(DEFAULT_POS_SALES_SETTINGS.max_rounding)
    expect(resolvePosSalesSettings(null)).toEqual(DEFAULT_POS_SALES_SETTINGS)
    expect(resolvePosSalesSettings('junk')).toEqual(DEFAULT_POS_SALES_SETTINGS)
  })

  it('keeps a stored null: a kind a person wants to review each time', () => {
    expect(resolvePosSalesSettings({ tender_accounts: { card: null } }).tender_accounts.card).toBeNull()
  })

  it('applies a patch without touching what it leaves out', () => {
    const next = applyPosSalesSettingsPatch(DEFAULT_POS_SALES_SETTINGS, {
      revenue_accounts: { '0': '2421' },
      tender_accounts: { invoice: '1510' },
      max_rounding: 2,
    })
    expect(next.revenue_accounts).toEqual({ ...DEFAULT_POS_SALES_SETTINGS.revenue_accounts, '0': '2421' })
    expect(next.tender_accounts.invoice).toBe('1510')
    expect(next.tender_accounts.card).toBe('1686')
    expect(next.max_rounding).toBe(2)
  })

  it('refuses a patch with an unknown key, an account that is not four digits, or a tender kind it does not know', () => {
    expect(posSalesSettingsPatchSchema.safeParse({ tips_account: '28200' }).success).toBe(false)
    expect(posSalesSettingsPatchSchema.safeParse({ auto_book: true }).success).toBe(false)
    expect(posSalesSettingsPatchSchema.safeParse({ tender_accounts: { bitcoin: '1686' } }).success).toBe(false)
    expect(posSalesSettingsPatchSchema.safeParse({ tender_accounts: { card: null } }).success).toBe(true)
    expect(posSalesSettingsPatchSchema.safeParse({ max_rounding: 11 }).success).toBe(false)
  })
})
