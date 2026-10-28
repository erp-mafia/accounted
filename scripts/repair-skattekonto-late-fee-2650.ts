#!/usr/bin/env -S npx tsx --conditions react-server
/**
 * One-off repair for the skattekonto late fee booked on 2650 (MR !936).
 *
 * Skatteverket writes the late fee as "Förs.avgift moms/arbetsgivardeklaration".
 * Until migration 20261027190100 the seeded moms rule matched that text before
 * the penalty rule, so the skattekonto flow booked it Debit 2650 / Credit 1630.
 * 2650 then carried a cost no VAT period clears, and the non-deductible fee
 * never reached 6992.
 *
 * This moves the debit to 6992 inside the same verifikat by inline rättelse
 * (strikeJournalEntryLines, BFL 5 kap 5 §): the RPC strikes the 2650 line, adds
 * the 6992 line and writes who and when to journal_entry_rattelse_log. Only a
 * verifikat that is exactly the rule's output is touched: posted, source_type
 * 'system', linked from a skattekonto row whose text starts "Förs.avgift",
 * with two lines, 2650 debit and 1630 credit of the row's amount. The RPC
 * itself refuses a closed or locked period. Everything else is printed and
 * skipped.
 *
 * The RPC requires a member of the company as the actor: the member who
 * committed the verifikat, else the owner. The actor label says Accounted made
 * the rättelse.
 *
 * Usage (read-only unless --commit):
 *   npx tsx --conditions react-server scripts/repair-skattekonto-late-fee-2650.ts --env-file <path>
 *   npx tsx --conditions react-server scripts/repair-skattekonto-late-fee-2650.ts --env-file <path> --commit
 */

import { config } from 'dotenv'
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import { registerScriptInitLoader } from './lib/register-init-loader'
import { runWithActor } from '../src/lib/bookkeeping/actor-context-node'
import { strikeJournalEntryLines } from '../src/lib/core/bookkeeping/journal-entry-corrections'
import { createLogger } from '../src/lib/logger'
import { roundOre } from '../src/lib/money'

registerScriptInitLoader()

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`)
  if (index < 0) return undefined
  const value = process.argv[index + 1]
  if (value === undefined || value.startsWith('--')) {
    console.error(`--${name} requires a value`)
    process.exit(1)
  }
  return value
}

const ENV_FILE = arg('env-file')
const COMMIT = process.argv.includes('--commit')
if (!ENV_FILE) {
  console.error('--env-file <path> is required (the file with NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)')
  process.exit(1)
}
config({ path: ENV_FILE })

const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!supabaseUrl || !serviceRoleKey) {
  console.error(`Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in ${ENV_FILE}`)
  process.exit(1)
}

const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } }) as SupabaseClient
const log = createLogger('scripts.repair-skattekonto-late-fee-2650')

const FEE_ACCOUNT = '6992'
const ACTOR_LABEL = 'Accounted: förseningsavgiften flyttad från 2650 till 6992 (fel i skattekontoregeln)'
const WRITE_ROLES = new Set(['owner', 'admin', 'member'])

interface Line {
  id: string
  account_number: string
  debit_amount: number
  credit_amount: number
  line_description: string | null
  dimensions: Record<string, string> | null
}

interface Entry {
  id: string
  company_id: string
  status: string
  source_type: string
  entry_date: string
  voucher_series: string | null
  voucher_number: number | null
  committed_by: string | null
  lines: Line[]
}

interface Candidate {
  entry: Entry
  feeLine: Line
  amount: number
  actorUserId: string
}

async function memberToActFor(companyId: string, committedBy: string | null): Promise<string | null> {
  const { data, error } = await supabase.from('company_members').select('user_id, role').eq('company_id', companyId)
  if (error) throw new Error(`company_members ${companyId}: ${error.message}`)
  const members = (data ?? []) as Array<{ user_id: string; role: string }>
  const committer = members.find((m) => m.user_id === committedBy && WRITE_ROLES.has(m.role))
  if (committer) return committer.user_id
  return members.find((m) => m.role === 'owner')?.user_id ?? null
}

async function findCandidates(): Promise<{ candidates: Candidate[]; skipped: string[] }> {
  const { data: rows, error } = await supabase
    .from('skattekonto_transactions')
    .select('journal_entry_id, belopp_skatteverket, transaktionstext')
    .ilike('transaktionstext', 'förs.avgift%')
    .not('journal_entry_id', 'is', null)
  if (error) throw new Error(`skattekonto_transactions: ${error.message}`)

  const amountByEntry = new Map<string, number>()
  for (const row of (rows ?? []) as Array<{ journal_entry_id: string; belopp_skatteverket: number }>) {
    amountByEntry.set(row.journal_entry_id, roundOre(Math.abs(Number(row.belopp_skatteverket))))
  }

  const candidates: Candidate[] = []
  const skipped: string[] = []
  const ids = [...amountByEntry.keys()]
  for (let i = 0; i < ids.length; i += 100) {
    const { data, error: entryError } = await supabase
      .from('journal_entries')
      .select('id, company_id, status, source_type, entry_date, voucher_series, voucher_number, committed_by, lines:journal_entry_lines(id, account_number, debit_amount, credit_amount, line_description, dimensions)')
      .in('id', ids.slice(i, i + 100))
    if (entryError) throw new Error(`journal_entries: ${entryError.message}`)

    for (const entry of (data ?? []) as unknown as Entry[]) {
      const amount = amountByEntry.get(entry.id) ?? 0
      const label = `${entry.id} (${entry.voucher_series ?? ''}${entry.voucher_number ?? ''}, ${entry.entry_date})`
      const feeLine = entry.lines.find((l) => l.account_number === '2650' && roundOre(Number(l.debit_amount)) === amount)
      const taxLine = entry.lines.find((l) => l.account_number === '1630' && roundOre(Number(l.credit_amount)) === amount)
      if (entry.status !== 'posted' || entry.source_type !== 'system') {
        skipped.push(`${label}: ${entry.status}/${entry.source_type}, not the rule's posted output`)
        continue
      }
      if (entry.lines.length !== 2 || !feeLine || !taxLine) {
        const shape = entry.lines.map((l) => `${l.account_number} ${Number(l.debit_amount) > 0 ? 'D' : 'C'}`).join(', ')
        skipped.push(`${label}: lines ${shape}, not 2650 D / 1630 C of ${amount}`)
        continue
      }
      const actorUserId = await memberToActFor(entry.company_id, entry.committed_by)
      if (!actorUserId) {
        skipped.push(`${label}: no member with write access to act for`)
        continue
      }
      candidates.push({ entry, feeLine, amount, actorUserId })
    }
  }
  return { candidates, skipped }
}

async function verify(entryId: string, amount: number): Promise<string | null> {
  const { data, error } = await supabase
    .from('journal_entry_lines')
    .select('account_number, debit_amount, credit_amount')
    .eq('journal_entry_id', entryId)
  if (error) return `re-read failed: ${error.message}`
  const lines = (data ?? []) as Array<{ account_number: string; debit_amount: number; credit_amount: number }>
  const fee = lines.find((l) => l.account_number === FEE_ACCOUNT && roundOre(Number(l.debit_amount)) === amount)
  const stray2650 = lines.find((l) => l.account_number === '2650')
  if (!fee || stray2650) return `unexpected lines after rättelse: ${JSON.stringify(lines)}`
  return null
}

async function main(): Promise<void> {
  console.log(`Supabase URL: ${supabaseUrl}`)
  console.log(`Mode        : ${COMMIT ? 'COMMIT (inline rättelse per verifikat)' : 'DRY RUN (no writes)'}`)

  const { candidates, skipped } = await findCandidates()
  for (const line of skipped) console.log(`skip  ${line}`)
  for (const c of candidates) {
    console.log(
      `${COMMIT ? 'fix ' : 'would'} ${c.entry.id} company ${c.entry.company_id} ${c.entry.voucher_series ?? ''}${c.entry.voucher_number ?? ''} ` +
        `${c.entry.entry_date}: 2650 D ${c.amount} -> ${FEE_ACCOUNT} D ${c.amount} (actor ${c.actorUserId})`,
    )
  }
  console.log(`\n${candidates.length} to correct, ${skipped.length} skipped`)
  if (!COMMIT) return

  let failed = 0
  for (const c of candidates) {
    const outcome = await runWithActor({ type: 'system', label: ACTOR_LABEL }, () =>
      strikeJournalEntryLines(
        { supabase, companyId: c.entry.company_id, userId: c.actorUserId, log },
        c.entry.id,
        {
          strike_line_ids: [c.feeLine.id],
          lines: [
            {
              account_number: FEE_ACCOUNT,
              debit_amount: c.amount,
              credit_amount: 0,
              line_description: c.feeLine.line_description ?? undefined,
              dimensions: c.feeLine.dimensions ?? undefined,
            },
          ],
        },
      ),
    )
    const problem = outcome.ok ? await verify(c.entry.id, c.amount) : JSON.stringify(outcome)
    if (problem) {
      failed++
      console.error(`FAIL ${c.entry.id}: ${problem}`)
    } else {
      console.log(`ok   ${c.entry.id}`)
    }
  }
  console.log(`\n${candidates.length - failed} corrected, ${failed} failed`)
  if (failed > 0) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
