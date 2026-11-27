import { z } from 'zod'
import { accountNumberSchema } from '@/lib/invariants/zod'

/**
 * Where a spend expense's counter side books, per connection, in
 * spend_connections.settings, always read merged over the defaults.
 *
 * - wallet_account: the 19xx account the provider's wallet (the company's
 *   money held at the card provider) sits on. Null takes the account the
 *   provider names on each expense (its contra account mapping); when both
 *   exist and differ, this one wins and the expense waits for a person.
 *   Pleo's own Swedish setup guide suggests a 194x account, a bank-type
 *   account beside 1930.
 * - out_of_pocket_account: what an utlägg or a kostnadsersättning is owed
 *   on until the person is paid back: 2820 Kortfristiga skulder till
 *   anställda, the same liability lib/expenses/payer.ts books an employee's
 *   utlägg to. An owner's own utlägg in an AB (2893) or an EF (2018) is a
 *   different account; a company where owners spend through the provider
 *   sets it here.
 */

/** The wallet is company money at the provider: a 19xx account (kassa och bank). */
export function isWalletAccount(account: string): boolean {
  return /^19\d\d$/.test(account)
}

const walletAccount = accountNumberSchema.refine(isWalletAccount, 'a 19xx account (kassa och bank)')

export const spendSettingsSchema = z.object({
  wallet_account: walletAccount.nullable(),
  out_of_pocket_account: accountNumberSchema,
})
export type SpendSettings = z.infer<typeof spendSettingsSchema>

export const DEFAULT_SPEND_SETTINGS: SpendSettings = {
  wallet_account: null,
  out_of_pocket_account: '2820',
}

/** What a caller may send to change settings: any subset. */
export const spendSettingsPatchSchema = spendSettingsSchema.partial().strict()
export type SpendSettingsPatch = z.infer<typeof spendSettingsPatchSchema>

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * The stored settings merged over the defaults. A stored value that no longer
 * validates (an older shape, a hand edit) falls back to the default for that
 * key instead of breaking the expense.
 */
export function resolveSpendSettings(stored: unknown): SpendSettings {
  const source = isRecord(stored) ? stored : {}
  const merged: SpendSettings = { ...DEFAULT_SPEND_SETTINGS }
  if (source.wallet_account === null || walletAccount.safeParse(source.wallet_account).success) {
    merged.wallet_account = (source.wallet_account ?? null) as string | null
  }
  if (accountNumberSchema.safeParse(source.out_of_pocket_account).success) {
    merged.out_of_pocket_account = source.out_of_pocket_account as string
  }
  return merged
}

/** Apply a validated patch on top of the resolved settings. */
export function applySpendSettingsPatch(current: SpendSettings, patch: SpendSettingsPatch): SpendSettings {
  return {
    ...current,
    ...(patch.wallet_account !== undefined ? { wallet_account: patch.wallet_account } : {}),
    ...(patch.out_of_pocket_account !== undefined ? { out_of_pocket_account: patch.out_of_pocket_account } : {}),
  }
}
