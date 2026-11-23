import { roundOre } from '@/lib/money'
import type { OperationContext, OperationOutcome } from '@/lib/operations/types'
import { isOssAccountCountry, isOssVatRate, ossAccountKind, type OssAccountKind } from './oss-accounts'

/**
 * The write behind "which EU country is this OSS account for"
 * (unionsordningen): one implementation behind the dashboard route
 * (/api/bookkeeping/accounts/oss-countries), the v1 operation
 * accounts.oss-countries (lib/operations/accounts.ts) and the MCP tool
 * generated from it, so every door applies the rules of ./oss-accounts.ts.
 *
 * It sets two fields on kontoplan rows and nothing else: the account's
 * name, number, VAT code and momsruta stay with
 * lib/bookkeeping/chart-of-accounts-service.ts, and no verifikat changes.
 */

/** One account and the country it is to name. */
export interface OssAccountCountryInput {
  account_number: string
  /**
   * The other EU country the account is for, ISO 3166-1 alpha-2. A VAT
   * account shared by every country takes 'EU'. null clears the account.
   */
  country: string | null
  /** Percent, e.g. 19 or 25.5: with a country on a sales account, never on a VAT account. */
  vat_rate?: number | null
}

export interface OssAccountCountryRow {
  account_number: string
  account_name: string
  kind: OssAccountKind
  oss_country: string | null
  oss_vat_rate: number | null
}

export interface SetOssAccountCountriesResult {
  /** Every account in the call, as it now stands. */
  accounts: OssAccountCountryRow[]
  updated: number
  unchanged: number
}

/** The account numbers named in full before the rest are counted. */
const TITLE_ACCOUNTS = 8

/**
 * The line a staged call is listed under: the accounts it sets, the first
 * few by number and the rest as a count, so a long list never reads as the
 * whole of it.
 */
export function ossAccountCountriesTitle(accountNumbers: readonly string[]): string {
  const named = accountNumbers.slice(0, TITLE_ACCOUNTS).join(', ')
  const rest = accountNumbers.length - TITLE_ACCOUNTS
  return rest > 0 ? `OSS-land på konton: ${named} och ${rest} till` : `OSS-land på konton: ${named}`
}

type Failure = Extract<OperationOutcome<never>, { ok: false }>

function refusal(accountNumber: string, sv: string, en: string): Failure {
  return {
    ok: false,
    code: 'VALIDATION_ERROR',
    details: { field: 'accounts', account_number: accountNumber, message: en },
    messageSv: sv,
    messageEn: en,
  }
}

/**
 * Says which EU country each OSS account is for, so the OSS underlag can
 * place the verifikat booked on it (lib/webshop-orders/oss-underlag.ts). A
 * sales account (VAT code OSS) takes one other EU country and that country's
 * rate; a VAT account (26xx other than 2650) takes a country, or 'EU' when it
 * is shared, and no rate. null clears the account.
 *
 * The rules are checked for every account before any row is written: one
 * account that cannot take what it is given refuses the whole call. A dry run
 * runs the same checks and answers what would change.
 */
export async function setOssAccountCountries(
  ctx: OperationContext,
  items: OssAccountCountryInput[],
  options: { dryRun?: boolean } = {},
): Promise<OperationOutcome<SetOssAccountCountriesResult>> {
  const { supabase, companyId, log } = ctx

  const numbers = items.map((item) => item.account_number)
  const repeated = numbers.find((number, i) => numbers.indexOf(number) !== i)
  if (repeated) {
    return refusal(repeated, `Konto ${repeated} finns med två gånger.`, `Account ${repeated} is listed twice.`)
  }

  const { data, error } = await supabase
    .from('chart_of_accounts')
    .select('account_number, account_name, default_vat_treatment, oss_country, oss_vat_rate')
    .eq('company_id', companyId)
    .in('account_number', numbers)
  if (error) {
    log.error('account fetch failed', error)
    return { ok: false, code: 'UNKNOWN_ERROR', error }
  }
  const chart = new Map(
    ((data ?? []) as Array<{
      account_number: string
      account_name: string
      default_vat_treatment: string | null
      oss_country: string | null
      oss_vat_rate: number | string | null
    }>).map((row) => [row.account_number, row]),
  )
  const missing = numbers.filter((number) => !chart.has(number))
  if (missing.length > 0) {
    return { ok: false, code: 'ACCOUNT_NOT_FOUND', details: { account_number: missing[0], account_numbers: missing } }
  }

  const accounts: OssAccountCountryRow[] = []
  const changes: OssAccountCountryRow[] = []
  for (const item of items) {
    const row = chart.get(item.account_number)!
    const number = item.account_number
    const kind = ossAccountKind(row)
    if (!kind) {
      return refusal(
        number,
        `Konto ${number} kan inte ange ett OSS-land. Det gör bara ett försäljningskonto med momskod OSS eller ett momskonto (26xx utom 2650).`,
        `Account ${number} cannot name an OSS country. Only a sales account with VAT code OSS or a VAT account (26xx other than 2650) can.`,
      )
    }

    const country = item.country
    let rate = country === null ? null : (item.vat_rate ?? null)
    if (country !== null) {
      if (!isOssAccountCountry(kind, country)) {
        return refusal(
          number,
          kind === 'vat'
            ? `${country} är inte ett annat EU-land. Ange landskoden med två versaler, till exempel DE, eller EU för ett momskonto som delas av alla länder.`
            : `${country} är inte ett annat EU-land. Ange landskoden med två versaler, till exempel DE.`,
          kind === 'vat'
            ? `${country} is not another EU country. Give the two-letter code in capitals, e.g. DE, or EU for a VAT account shared by every country.`
            : `${country} is not another EU country. Give the two-letter code in capitals, e.g. DE.`,
        )
      }
      if (kind === 'sales' && !isOssVatRate(rate)) {
        return refusal(
          number,
          `Konto ${number} behöver landets momssats i procent, till exempel 19 eller 25,5.`,
          `Account ${number} needs the country's VAT rate in percent, e.g. 19 or 25.5.`,
        )
      }
      if (kind === 'vat' && rate !== null) {
        return refusal(
          number,
          `Momskonto ${number} anger bara land. Momssatsen följer försäljningen momsen bokförs med.`,
          `VAT account ${number} names a country only. The rate follows the sale the VAT is booked with.`,
        )
      }
      // Two decimals, as the column stores it: what is answered is what is saved.
      if (rate !== null) rate = roundOre(rate)
    }

    const next: OssAccountCountryRow = {
      account_number: number,
      account_name: row.account_name,
      kind,
      oss_country: country,
      oss_vat_rate: rate,
    }
    accounts.push(next)
    const currentRate = row.oss_vat_rate == null ? null : Number(row.oss_vat_rate)
    if ((row.oss_country ?? null) !== country || currentRate !== rate) changes.push(next)
  }

  if (options.dryRun) {
    return {
      ok: true,
      dryRun: true,
      preview: {
        changes: changes.map((change) => {
          const current = chart.get(change.account_number)!
          return {
            account_number: change.account_number,
            account_name: change.account_name,
            kind: change.kind,
            current: {
              oss_country: current.oss_country ?? null,
              oss_vat_rate: current.oss_vat_rate == null ? null : Number(current.oss_vat_rate),
            },
            next: { oss_country: change.oss_country, oss_vat_rate: change.oss_vat_rate },
          }
        }),
        unchanged: accounts.length - changes.length,
      },
    }
  }

  // One row at a time: each account takes its own values. A failure part way
  // leaves the earlier rows set; the same call again finishes the rest.
  for (const change of changes) {
    const { error: updateError } = await supabase
      .from('chart_of_accounts')
      .update({ oss_country: change.oss_country, oss_vat_rate: change.oss_vat_rate })
      .eq('company_id', companyId)
      .eq('account_number', change.account_number)
    if (updateError) {
      log.error('account OSS country update failed', updateError, { account_number: change.account_number })
      return { ok: false, code: 'UNKNOWN_ERROR', error: updateError }
    }
  }

  return { ok: true, data: { accounts, updated: changes.length, unchanged: accounts.length - changes.length } }
}
