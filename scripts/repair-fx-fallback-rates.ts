/**
 * One-off repair: transactions booked with the pre-2026-07-05 hardcoded
 * fallback exchange rates (EUR 11.5, USD 10.5, GBP 13.5) or with NULL rates.
 *
 * WHY: before PR #892, a Riksbanken 429 during bank sync silently booked
 * hardcoded rates into transactions.exchange_rate/amount_sek. PR #892 fixed
 * the code path (null-not-fallback); this repairs the rows left behind.
 *
 * WHAT IT DOES:
 *   - UNBOOKED rows (journal_entry_id IS NULL): re-fetches the correct
 *     per-date rate from Riksbanken (via the exchange_rates cache) and
 *     overwrites exchange_rate / exchange_rate_date / amount_sek.
 *   - BOOKED rows (posted to journal entries): NEVER touched. Reported as a
 *     per-company materiality summary so corrections can be decided per
 *     company (storno/correctEntry, never edit posted entries).
 *
 * Idempotent: updates are guarded on the exact old rate value (or NULL) plus
 * journal_entry_id IS NULL, so re-runs and concurrent bookings are safe.
 * Once a row is repaired it no longer matches the poisoned pattern.
 *
 * Usage:
 *   npx tsx scripts/repair-fx-fallback-rates.ts            # dry run (read-only)
 *   npx tsx scripts/repair-fx-fallback-rates.ts --execute  # performs the writes
 *
 * Reads NEXT_PUBLIC_SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY from .env.local.
 * Treat .env.local as pointing at PRODUCTION.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { config as dotenv } from 'dotenv'
import { resolve } from 'node:path'
import { fetchExchangeRate } from '@/lib/currency/riksbanken'
import type { Currency, ExchangeRate } from '@/types'

dotenv({ path: resolve(process.cwd(), '.env.local') })

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

const EXECUTE = process.argv.includes('--execute')

/** The exact sentinel rates the old getFallbackRate() booked. */
const POISONED: Array<{ currency: Currency; rate: number }> = [
  { currency: 'EUR', rate: 11.5 },
  { currency: 'USD', rate: 10.5 },
  { currency: 'GBP', rate: 13.5 },
]

interface TxRow {
  id: string
  company_id: string
  currency: Currency
  amount: number
  amount_sek: number | null
  exchange_rate: number | null
  exchange_rate_date: string | null
  date: string
  journal_entry_id: string | null
}

const sb: SupabaseClient = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false },
})

/** In-process memo so repeated (currency, date) pairs cost one lookup. */
const rateMemo = new Map<string, Promise<ExchangeRate | null>>()
function getRate(currency: Currency, date: string): Promise<ExchangeRate | null> {
  const key = `${currency}|${date}`
  let p = rateMemo.get(key)
  if (!p) {
    p = fetchExchangeRate(currency, new Date(date), sb)
    rateMemo.set(key, p)
  }
  return p
}

const roundMoney = (x: number) => Math.round(x * 100) / 100

async function main() {
  const host = new URL(SUPABASE_URL!).host
  console.log(`Target: ${host}   mode: ${EXECUTE ? 'WRITE (--execute)' : 'DRY RUN (read-only)'}`)

  const orFilter = POISONED.map(
    (p) => `and(currency.eq.${p.currency},exchange_rate.eq.${p.rate})`,
  ).join(',')

  const { data: poisonedRows, error: e1 } = await sb
    .from('transactions')
    .select('id, company_id, currency, amount, amount_sek, exchange_rate, exchange_rate_date, date, journal_entry_id')
    .or(orFilter)
  if (e1) throw new Error(`select poisoned: ${e1.message}`)

  const { data: nullRows, error: e2 } = await sb
    .from('transactions')
    .select('id, company_id, currency, amount, amount_sek, exchange_rate, exchange_rate_date, date, journal_entry_id')
    .not('currency', 'is', null)
    .neq('currency', 'SEK')
    .is('exchange_rate', null)
  if (e2) throw new Error(`select null-rate: ${e2.message}`)

  const all: TxRow[] = [...(poisonedRows ?? []), ...(nullRows ?? [])] as TxRow[]
  const unbooked = all.filter((r) => r.journal_entry_id === null)
  const booked = all.filter((r) => r.journal_entry_id !== null)

  console.log(
    `Found ${all.length} rows: ${unbooked.length} unbooked (repairable), ${booked.length} booked (report only).`,
  )

  // ---- Repair (or plan) unbooked rows, sequentially to be gentle on Riksbanken.
  let repaired = 0
  let skipped = 0
  for (const r of unbooked) {
    const rate = await getRate(r.currency, r.date)
    if (!rate) {
      console.log(`  SKIP ${r.id} ${r.currency} ${r.date}: no rate available`)
      skipped++
      continue
    }
    const newSek = roundMoney(r.amount * rate.rate)
    const oldRate = r.exchange_rate === null ? 'NULL' : r.exchange_rate
    console.log(
      `  ${EXECUTE ? 'FIX ' : 'PLAN'} ${r.id} ${r.currency} ${r.date}: rate ${oldRate} -> ${rate.rate} (obs ${rate.date}), amount_sek ${r.amount_sek} -> ${newSek}`,
    )
    if (!EXECUTE) continue

    let q = sb
      .from('transactions')
      .update({ exchange_rate: rate.rate, exchange_rate_date: rate.date, amount_sek: newSek })
      .eq('id', r.id)
      .is('journal_entry_id', null)
    q = r.exchange_rate === null ? q.is('exchange_rate', null) : q.eq('exchange_rate', r.exchange_rate)
    const { error: upErr } = await q
    if (upErr) throw new Error(`update ${r.id}: ${upErr.message}`)
    repaired++
  }

  // ---- Materiality report for booked rows (never modified).
  if (booked.length > 0) {
    console.log('\nBOOKED rows (NOT touched; correct via storno/correctEntry per company if material):')
    const byCompany = new Map<string, { n: number; storedSek: number; correctSek: number; missing: number }>()
    for (const r of booked) {
      const agg = byCompany.get(r.company_id) ?? { n: 0, storedSek: 0, correctSek: 0, missing: 0 }
      agg.n++
      const rate = await getRate(r.currency, r.date)
      if (rate) {
        agg.storedSek += r.amount_sek ?? 0
        agg.correctSek += roundMoney(r.amount * rate.rate)
      } else {
        agg.missing++
      }
      byCompany.set(r.company_id, agg)
    }
    for (const [companyId, a] of byCompany) {
      const diff = roundMoney(a.storedSek - a.correctSek)
      console.log(
        `  company ${companyId}: ${a.n} booked row(s), stored SEK ${roundMoney(a.storedSek)}, correct SEK ${roundMoney(a.correctSek)}, overstatement ${diff}${a.missing ? `, ${a.missing} row(s) without fetchable rate` : ''}`,
      )
    }
  }

  console.log(
    `\n${EXECUTE ? `Repaired ${repaired} unbooked row(s), skipped ${skipped}.` : `DRY RUN: would repair ${unbooked.length} unbooked row(s). Re-run with --execute.`}`,
  )
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
