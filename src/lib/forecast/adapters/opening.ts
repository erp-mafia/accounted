/**
 * The opening balance: what the banks last reported for the company's SEK
 * bank accounts (cash_accounts.balance), with its age. Only when no bank
 * account has a reported balance does the forecast start from the booked
 * balance (the bank_balance measure), and it says so: bank rows without a
 * verifikat are not in a booked balance.
 */
import type { SupabaseClient } from '@supabase/supabase-js'
import { isLedgerCurrency } from '@/lib/bookkeeping/currency-utils'
import { isBankCashAccount } from '@/lib/cash-accounts/invoice-payee-rules'
import { daysBetweenIso, todayIsoStockholm } from '@/lib/dates/iso'
import { getMeasure } from '@/lib/measures'
import { roundOre } from '@/lib/money'
import type { ForecastCaveat, ForecastOpening } from '../types'

export interface OpeningCashAccountRow {
  id: string
  name: string | null
  ledger_account: string
  currency: string
  balance: number | string | null
  balance_updated_at: string | null
  enabled: boolean
  kind?: string | null
}

export interface OpeningFromBank {
  opening: ForecastOpening | null
  caveats: ForecastCaveat[]
  /** cash_account_id -> when its balance was reported: an executed payment after it is not in the opening yet. */
  balanceTimes: Map<string, string>
}

/** The bank-reported opening, or null when no SEK bank account has a reported balance. */
export function openingFromBankBalances(rows: readonly OpeningCashAccountRow[], today: string): OpeningFromBank {
  const banks = rows.filter((r) => r.enabled && (r.kind ?? 'bank') === 'bank' && isBankCashAccount(r))
  const foreign = banks.filter((r) => !isLedgerCurrency(r.currency))
  const sek = banks.filter((r) => isLedgerCurrency(r.currency))
  const reported = sek.filter((r) => r.balance !== null && r.balance !== undefined && Number.isFinite(Number(r.balance)))
  const unreported = sek.filter((r) => !reported.includes(r))
  const caveats: ForecastCaveat[] = []
  const balanceTimes = new Map<string, string>()
  for (const r of reported) if (r.balance_updated_at) balanceTimes.set(r.id, r.balance_updated_at)

  if (foreign.length > 0) {
    caveats.push({
      code: 'FOREIGN_CURRENCY_ACCOUNTS_LEFT_OUT',
      message_sv: `${foreign.length} bankkonto i annan valuta än SEK ingår inte i prognosen.`,
      message_en: `${foreign.length} bank account(s) in a currency other than SEK are not in the forecast.`,
    })
  }
  if (reported.length === 0) return { opening: null, caveats, balanceTimes }

  if (unreported.length > 0) {
    caveats.push({
      code: 'BANK_ACCOUNTS_WITHOUT_BALANCE',
      message_sv: `Saldot från banken saknas för ${unreported.map((r) => r.ledger_account).join(', ')}. De kontona ingår inte i ingående saldo.`,
      message_en: `No bank balance for ${unreported.map((r) => r.ledger_account).join(', ')}. Those accounts are not in the opening balance.`,
    })
  }
  const times = reported.map((r) => r.balance_updated_at).filter((t): t is string => !!t).sort()
  const oldest = times[0] ?? null
  return {
    opening: {
      amount: roundOre(reported.reduce((sum, r) => sum + Number(r.balance), 0)),
      source: 'bank',
      as_of: oldest,
      age_days: oldest ? Math.max(0, daysBetweenIso(todayIsoStockholm(new Date(oldest)), today)) : null,
      accounts: reported.map((r) => ({
        cash_account_id: r.id,
        ledger_account: r.ledger_account,
        name: r.name,
        balance: roundOre(Number(r.balance)),
        balance_updated_at: r.balance_updated_at,
      })),
    },
    caveats,
    balanceTimes,
  }
}

export interface LoadedOpening {
  opening: ForecastOpening
  caveats: ForecastCaveat[]
  balanceTimes: Map<string, string>
}

export async function loadOpening(supabase: SupabaseClient, companyId: string, today: string): Promise<LoadedOpening> {
  const { data, error } = await supabase
    .from('cash_accounts')
    .select('id, name, ledger_account, currency, balance, balance_updated_at, enabled, kind')
    .eq('company_id', companyId)
  if (error) throw Object.assign(new Error(`cash accounts read failed: ${error.message}`), { code: error.code })
  const fromBank = openingFromBankBalances((data ?? []) as OpeningCashAccountRow[], today)
  if (fromBank.opening) return { opening: fromBank.opening, caveats: fromBank.caveats, balanceTimes: fromBank.balanceTimes }

  const measured = await getMeasure({ supabase, companyId }, 'bank_balance', { as_of_date: today }, { today })
  if (!measured.ok) {
    return {
      opening: { amount: 0, source: 'unknown', as_of: null, age_days: null, accounts: [] },
      caveats: [
        ...fromBank.caveats,
        {
          code: 'OPENING_BALANCE_UNKNOWN',
          message_sv: 'Inget banksaldo och inget bokfört saldo kunde läsas. Prognosen startar från 0 kr.',
          message_en: 'Neither a bank balance nor a booked balance could be read. The forecast starts from SEK 0.',
        },
      ],
      balanceTimes: fromBank.balanceTimes,
    }
  }
  return {
    opening: { amount: roundOre(measured.data.value), source: 'booked', as_of: measured.data.as_of, age_days: 0, accounts: [] },
    caveats: [
      ...fromBank.caveats,
      {
        code: 'OPENING_BALANCE_BOOKED',
        message_sv:
          'Inget bankkonto har ett saldo från banken, så prognosen startar från det bokförda banksaldot. Banktransaktioner som inte är bokförda ingår inte i det.',
        message_en:
          'No bank account has a balance reported by the bank, so the forecast starts from the booked bank balance. Bank transactions not yet booked are not in it.',
      },
    ],
    balanceTimes: fromBank.balanceTimes,
  }
}
