import { describe, expect, it } from 'vitest'
import { isStandardBASAccount } from '@/lib/bookkeeping/bas-reference'
import {
  DEFAULT_SPEND_SETTINGS,
  applySpendSettingsPatch,
  resolveSpendSettings,
  spendSettingsPatchSchema,
  spendSettingsSchema,
} from '../settings'

describe('spend settings', () => {
  it('defaults to the BAS liability for employee utlägg and no wallet account of its own', () => {
    expect(spendSettingsSchema.safeParse(DEFAULT_SPEND_SETTINGS).success).toBe(true)
    expect(DEFAULT_SPEND_SETTINGS.out_of_pocket_account).toBe('2820')
    expect(isStandardBASAccount(DEFAULT_SPEND_SETTINGS.out_of_pocket_account)).toBe(true)
    // Null: the provider's contra account mapping is used until the company picks one.
    expect(DEFAULT_SPEND_SETTINGS.wallet_account).toBeNull()
  })

  it('keeps valid stored values', () => {
    expect(resolveSpendSettings({ wallet_account: '1940', out_of_pocket_account: '2893' })).toEqual({
      wallet_account: '1940',
      out_of_pocket_account: '2893',
    })
    expect(resolveSpendSettings({ wallet_account: null, out_of_pocket_account: '2018' })).toEqual({
      wallet_account: null,
      out_of_pocket_account: '2018',
    })
  })

  it('falls back to the default for a stored value that no longer validates', () => {
    for (const wallet of ['1510', '194', '19400', 1940, 'kort']) {
      expect(resolveSpendSettings({ wallet_account: wallet }).wallet_account, String(wallet)).toBeNull()
    }
    for (const account of ['28', '28200', 2820, null]) {
      expect(resolveSpendSettings({ out_of_pocket_account: account }).out_of_pocket_account, String(account)).toBe('2820')
    }
    expect(resolveSpendSettings({ wallet_account: '1940', out_of_pocket_account: 'x', auto_book: true })).toEqual({
      wallet_account: '1940',
      out_of_pocket_account: '2820',
    })
  })

  it('answers the defaults for anything that is not a stored map', () => {
    for (const stored of [null, undefined, 'junk', 42, ['1940'], {}]) {
      expect(resolveSpendSettings(stored)).toEqual(DEFAULT_SPEND_SETTINGS)
    }
  })

  it('applies a patch without touching what it leaves out', () => {
    const current = { wallet_account: '1940', out_of_pocket_account: '2820' }
    expect(applySpendSettingsPatch(current, { out_of_pocket_account: '2893' })).toEqual({ wallet_account: '1940', out_of_pocket_account: '2893' })
    expect(applySpendSettingsPatch(current, { wallet_account: null })).toEqual({ wallet_account: null, out_of_pocket_account: '2820' })
    expect(applySpendSettingsPatch(DEFAULT_SPEND_SETTINGS, { wallet_account: '1941' })).toEqual({ wallet_account: '1941', out_of_pocket_account: '2820' })
    expect(applySpendSettingsPatch(current, {})).toEqual(current)
  })

  it('refuses a patch with an unknown key, a wallet outside 19xx, or an account that is not four digits', () => {
    expect(spendSettingsPatchSchema.safeParse({}).success).toBe(true)
    expect(spendSettingsPatchSchema.safeParse({ wallet_account: '1940' }).success).toBe(true)
    expect(spendSettingsPatchSchema.safeParse({ wallet_account: null }).success).toBe(true)
    expect(spendSettingsPatchSchema.safeParse({ out_of_pocket_account: '2893' }).success).toBe(true)
    expect(spendSettingsPatchSchema.safeParse({ wallet_account: '1510' }).success).toBe(false)
    expect(spendSettingsPatchSchema.safeParse({ wallet_account: '19400' }).success).toBe(false)
    expect(spendSettingsPatchSchema.safeParse({ wallet_account: 1940 }).success).toBe(false)
    expect(spendSettingsPatchSchema.safeParse({ out_of_pocket_account: 2820 }).success).toBe(false)
    expect(spendSettingsPatchSchema.safeParse({ out_of_pocket_account: null }).success).toBe(false)
    expect(spendSettingsPatchSchema.safeParse({ auto_book: true }).success).toBe(false)
  })

  it('needs both keys in a full settings object', () => {
    expect(spendSettingsSchema.safeParse({ wallet_account: '1940' }).success).toBe(false)
    expect(spendSettingsSchema.safeParse({ out_of_pocket_account: '2820' }).success).toBe(false)
  })
})
