/**
 * Comprehensive charset repair for chart_of_accounts account names.
 *
 * Background: account names were corrupted for ~888 companies in the seeding /
 * import window 2026-03-30 → 2026-06-12, in three signatures (see
 * lib/bookkeeping/charset-repair.ts): stripped diacritics, lost-byte U+FFFD, and
 * double-encoded UTF-8. The root causes are CLOSED: the runtime
 * seed_chart_of_accounts() function on prod now carries correct diacritics (the
 * fix migration 20260516130000 was applied to prod ~2026-06-12; classic
 * prod-migration-drift, so companies created during the drift window were
 * seeded by the old stripped function). This script repairs the legacy rows.
 *
 * Strategy (per row): resolveCorrectName() against CANDIDATE correct names for
 * the same account number: the clean sibling rows already in the table plus the
 * BAS reference name. Double-encoded reverses losslessly (recovers customs too);
 * stripped/lost-byte require an unambiguous clean sibling, else the row is left
 * untouched and reported. Never clobbers user-renamed accounts.
 *
 * Usage: npx tsx scripts/repair-chart-of-accounts-charset.ts [--execute]
 * Without --execute it prints the plan only (dry run). Idempotent: clean rows
 * resolve to no-op, so re-running is safe.
 */
import fs from 'fs'
import path from 'path'
import { createClient } from '@supabase/supabase-js'
import { getBASReference } from '@/lib/bookkeeping/bas-reference'
import {
  resolveCorrectName,
  hasLostByte,
  hasMojibakeSignature,
  hasCp1252Artifact,
  isClean,
  type RepairResult,
} from '@/lib/bookkeeping/charset-repair'

const isCorrupt = (s: string) =>
  hasLostByte(s) || hasMojibakeSignature(s) || hasCp1252Artifact(s)

function loadEnv(): { url: string; key: string } {
  const envPath = path.resolve(process.cwd(), '.env.local')
  const vars: Record<string, string> = {}
  for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/)
    if (m) vars[m[1]] = m[2].trim()
  }
  const url = vars.NEXT_PUBLIC_SUPABASE_URL
  const key = vars.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) throw new Error('Missing Supabase env in .env.local')
  if (!url.includes('pwxtzglxptnnvjrpixpg')) {
    throw new Error(`Refusing to run against unexpected project: ${url}`)
  }
  return { url, key }
}

const EXECUTE = process.argv.includes('--execute')

interface Row {
  id: string
  company_id: string
  account_number: string
  account_name: string
}

async function main() {
  const { url, key } = loadEnv()
  const supabase = createClient(url, key, { auth: { persistSession: false } })

  console.log(`=== chart_of_accounts charset repair: ${EXECUTE ? 'EXECUTE' : 'DRY RUN'} ===\n`)

  // Closure over the inferred client so we don't annotate (and mismatch) the
  // supabase-js generic parameters.
  const fetchAll = async (): Promise<Row[]> => {
    const out: Row[] = []
    const PAGE = 1000
    for (let from = 0; ; from += PAGE) {
      const { data, error } = await supabase
        .from('chart_of_accounts')
        .select('id, company_id, account_number, account_name')
        .order('id', { ascending: true })
        .range(from, from + PAGE - 1)
      if (error) throw new Error(`fetch chart_of_accounts failed: ${error.message}`)
      const batch = (data ?? []) as Row[]
      out.push(...batch)
      if (batch.length < PAGE) break
    }
    return out
  }

  const rows = await fetchAll()
  console.log(`Scanned ${rows.length} chart_of_accounts rows across ${new Set(rows.map((r) => r.company_id)).size} companies.\n`)

  // Candidate correct names per account number = clean sibling names in the
  // table + the BAS reference name. (Clean = no lost-byte, no mojibake.)
  const candidates = new Map<string, Set<string>>()
  for (const r of rows) {
    if (isClean(r.account_name)) {
      const set = candidates.get(r.account_number) ?? new Set<string>()
      set.add(r.account_name)
      candidates.set(r.account_number, set)
    }
  }
  for (const r of rows) {
    const bas = getBASReference(r.account_number)?.account_name
    if (bas) {
      const set = candidates.get(r.account_number) ?? new Set<string>()
      set.add(bas)
      candidates.set(r.account_number, set)
    }
  }

  const fixes: Array<Row & { result: RepairResult }> = []
  const unresolved: Row[] = []
  for (const r of rows) {
    const cand = [...(candidates.get(r.account_number) ?? new Set<string>())]
    const result = resolveCorrectName(r.account_name, cand)
    if (result && result.corrected !== r.account_name) {
      fixes.push({ ...r, result })
    } else if (!result && isCorrupt(r.account_name)) {
      unresolved.push(r) // carries a corruption signature but no confident fix
    }
  }

  // ── Report ──────────────────────────────────────────────────────
  const byMethod = (m: RepairResult['method']) => fixes.filter((f) => f.result.method === m)
  const sample = (arr: Array<Row & { result: RepairResult }>) =>
    arr.slice(0, 8).map((f) => `   ${f.account_number}  "${f.account_name}"  →  "${f.result.corrected}"`)

  for (const m of ['sibling_stripped', 'reverse', 'reverse_cp437', 'sibling_lostbyte'] as const) {
    const g = byMethod(m)
    console.log(`[${m}] ${g.length} rows across ${new Set(g.map((f) => f.company_id)).size} companies`)
    if (g.length) console.log(sample(g).join('\n'))
    console.log()
  }
  console.log(`Total fixes: ${fixes.length} rows across ${new Set(fixes.map((f) => f.company_id)).size} companies.`)

  if (unresolved.length) {
    console.log(`\n[unresolved] ${unresolved.length} rows carry a corruption signature but have no unambiguous clean sibling: left untouched:`)
    console.log(
      [...new Map(unresolved.map((u) => [`${u.account_number}|${u.account_name}`, u])).values()]
        .slice(0, 20)
        .map((u) => `   ${u.account_number}  "${u.account_name}"`)
        .join('\n'),
    )
  }

  if (!EXECUTE) {
    console.log('\nDRY RUN: no rows changed. Re-run with --execute to apply.')
    return
  }

  // ── Apply (chunked) ─────────────────────────────────────────────
  let applied = 0
  let skipped = 0
  let errors = 0
  const CHUNK = 25
  for (let i = 0; i < fixes.length; i += CHUNK) {
    const chunk = fixes.slice(i, i + CHUNK)
    const results = await Promise.all(
      chunk.map((f) =>
        supabase
          .from('chart_of_accounts')
          .update({ account_name: f.result.corrected })
          .eq('id', f.id)
          .eq('company_id', f.company_id)
          // TOCTOU guard: only write if the row still holds the exact corrupted
          // value we read. A concurrent rename → 0 rows changed (skipped, not
          // clobbered). Also makes the script strictly idempotent.
          .eq('account_name', f.account_name)
          .select('id')
          .then(({ data, error }) =>
            error
              ? { ok: false as const, msg: error.message }
              : { ok: true as const, changed: (data?.length ?? 0) > 0 }),
      ),
    )
    for (const r of results) {
      if (!r.ok) {
        errors++
        console.error(`  update failed: ${r.msg}`)
      } else if (r.changed) {
        applied++
      } else {
        skipped++ // row changed under us since the read: left as-is
      }
    }
    if ((i / CHUNK) % 10 === 0) console.log(`  …${applied}/${fixes.length} applied`)
  }
  console.log(`\nDone. Applied ${applied}, skipped ${skipped}, errors ${errors}.`)
}

main().catch((err) => {
  console.error('\nREPAIR FAILED:', err)
  process.exit(1)
})
