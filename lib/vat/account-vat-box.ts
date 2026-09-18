/**
 * Per-account momsruta for VAT accounts (klass 26).
 *
 * The declaration maps 26xx accounts to their ruta by BAS number
 * (ACCOUNT_RUTA in lib/reports/vat-declaration.ts). A chart that predates
 * the 2015 BAS layout, or that a source system laid out differently, books
 * the same VAT on other numbers: Fortnox charts commonly carry EU-förvärv on
 * 2615, import on 2616 and tjänster utanför EU on 2617, where BAS reads
 * 2615 as import (ruta 60), 2616 as VMB (ruta 10) and knows no 2617 at all.
 * Renaming the accounts on import is not an option (the numbers are the
 * company's history), so the account itself carries the ruta it feeds.
 *
 * `vat_box` on chart_of_accounts is that override: null keeps the BAS
 * mapping, a box code routes the balance there, 'none' keeps the account
 * out of the declaration. Only 26xx accounts other than 2650 (the
 * momsredovisning clearing account) may carry one; the DB CHECK mirrors
 * ACCOUNT_VAT_BOXES and isVatBoxAccount.
 */
import { ACCOUNT_TO_BOX, BOX_LABELS, type MomsBox } from './moms-box-mapping'
import type { AccountVatRutaMapping } from './account-vat-treatment'

/** Boxes a VAT account can feed: output VAT (10-12, 30-32, 60-62) or input VAT (48). */
export const ACCOUNT_VAT_BOX_CODES = [
  '10', '11', '12',
  '30', '31', '32',
  '60', '61', '62',
  '48',
] as const

/** The stored values: a box code, or 'none' to keep the account out of the declaration. */
export const ACCOUNT_VAT_BOXES = [...ACCOUNT_VAT_BOX_CODES, 'none'] as const

export type AccountVatBoxCode = typeof ACCOUNT_VAT_BOX_CODES[number]
export type AccountVatBox = typeof ACCOUNT_VAT_BOXES[number]

export function isAccountVatBox(value: unknown): value is AccountVatBox {
  return typeof value === 'string' && (ACCOUNT_VAT_BOXES as readonly string[]).includes(value)
}

/**
 * Whether an account may carry a momsruta override: a four-digit 26xx
 * number other than 2650. 2650 nets the declaration and must never feed a
 * box; every other 26xx account is a VAT account by BAS convention.
 */
export function isVatBoxAccount(accountNumber: string): boolean {
  return /^26\d{2}$/.test(accountNumber) && accountNumber !== '2650'
}

/**
 * The ruta an override routes the balance to, in the shape the declaration
 * consumes for dynamic accounts. Output VAT boxes read the credit balance,
 * ruta 48 the debit balance. 'none' maps nowhere (null).
 */
export function vatBoxRutaMapping(box: AccountVatBox): AccountVatRutaMapping | null {
  if (box === 'none') return null
  return { box: `ruta${box}` as AccountVatRutaMapping['box'], side: box === '48' ? 'debit' : 'credit' }
}

/** The BAS box a VAT account feeds without an override, or null when BAS knows no such number. */
export function basVatBox(accountNumber: string): AccountVatBoxCode | null {
  const box = ACCOUNT_TO_BOX[accountNumber]
  return box && (ACCOUNT_VAT_BOX_CODES as readonly string[]).includes(box)
    ? (box as AccountVatBoxCode)
    : null
}

export function vatBoxLabel(box: AccountVatBox): string {
  return box === 'none' ? 'Ingen ruta' : BOX_LABELS[box as MomsBox]
}

/** The last digit of the box for the rate the name states: 25 % (or unstated) 0, 12 % 1, 6 % 2. */
function rateDigit(name: string): '0' | '1' | '2' {
  if (/\b12\s*%|\b12\s*procent/.test(name)) return '1'
  if (/\b6\s*%|\b6\s*procent/.test(name)) return '2'
  return '0'
}

/**
 * The box an account's NAME says it feeds, when the name is unambiguous:
 * "import" is ruta 60-62, "ingående" is ruta 48, and EU-förvärv, omvänd
 * skattskyldighet or inköp från utlandet (varor eller tjänster) is ruta
 * 30-32. Plain "utgående moms" is ruta 10-12. Null when the name says
 * nothing. Used to flag a deviation from the BAS number in the account
 * dialog; it never sets the override by itself.
 */
export function suggestVatBoxFromName(accountName: string): AccountVatBoxCode | null {
  const name = accountName.toLowerCase()
  if (!/moms/.test(name)) return null
  const rate = rateDigit(name)
  if (/ingående/.test(name)) return '48'
  if (/import/.test(name)) return `6${rate}` as AccountVatBoxCode
  if (
    /omvänd|förvärv|\beu\b|eu-|utanför eu|utland|tredje ?land/.test(name) ||
    (/inköp/.test(name) && /tjänst|varor/.test(name))
  ) {
    return `3${rate}` as AccountVatBoxCode
  }
  if (/utgående/.test(name)) return `1${rate}` as AccountVatBoxCode
  return null
}

/**
 * The box the name suggests when it differs from what the BAS number gives
 * (or when BAS gives nothing): the deviation the dialog points out. Null
 * when name and number agree or the name is silent.
 */
export function vatBoxDeviationFromName(
  accountNumber: string,
  accountName: string,
): AccountVatBoxCode | null {
  if (!isVatBoxAccount(accountNumber)) return null
  const suggested = suggestVatBoxFromName(accountName)
  if (!suggested) return null
  return suggested === basVatBox(accountNumber) ? null : suggested
}
