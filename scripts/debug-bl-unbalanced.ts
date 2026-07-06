/**
 * Temporary diagnostic: list every unbalanced voucher in the BL SIE export
 * with its lines, write a CSV report, and print summary statistics.
 * Run: npx tsx --env-file=.env --env-file=.env.local scripts/debug-bl-unbalanced.ts
 */
import { writeFileSync } from 'node:fs'
import { createClient } from '@supabase/supabase-js'
import { fetchBjornLundenToken } from '@/lib/providers/bjornlunden/oauth'
import { fetchProviderSieFiles } from '@/extensions/general/arcim-migration/lib/sie-fetcher'
import { parseSIEFile } from '@/lib/import/sie-parser'

const consentId = process.argv[2]
if (!consentId) {
  console.error('Usage: npx tsx --env-file=.env --env-file=.env.local scripts/debug-bl-unbalanced.ts <consentId>')
  console.error('Refusing to run without an explicit consentId: this script reads a live BL company and writes a report.')
  process.exit(1)
}

function isoLocal(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

async function main() {
  const supabase = createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
  )
  const { data: tokens, error } = await supabase
    .from('provider_consent_tokens')
    .select('provider_company_id')
    .eq('consent_id', consentId)
    .limit(1)
  if (error || !tokens?.length) throw new Error(`no tokens for consent: ${error?.message ?? 'not found'}`)
  const userKey = tokens[0]!.provider_company_id as string

  const token = await fetchBjornLundenToken(
    process.env.BJORN_LUNDEN_CLIENT_ID!,
    process.env.BJORN_LUNDEN_CLIENT_SECRET!,
  )
  const { files } = await fetchProviderSieFiles('bjornlunden', token.access_token, userKey)

  for (const f of files) {
    const parsed = parseSIEFile(f.rawContent)
    const bad = parsed.vouchers
      .map((v) => ({
        voucher: `${v.series}${v.number}`,
        date: isoLocal(v.date),
        description: v.description,
        lineCount: v.lines.length,
        diff: Math.round(v.lines.reduce((s, l) => s + l.amount, 0) * 100) / 100,
        lines: v.lines.map((l) => `${l.account}:${l.amount}`).join(' '),
      }))
      .filter((v) => Math.abs(v.diff) > 0.01 || v.lineCount === 0)

    const total = parsed.vouchers.length
    const empty = bad.filter((v) => v.lineCount === 0).length
    const single = bad.filter((v) => v.lineCount === 1).length
    const multi = bad.filter((v) => v.lineCount > 1).length

    console.log(`fiscal year ${f.fiscalYear}: ${total} vouchers total, ${bad.length} broken`)
    console.log(`  empty (0 lines):        ${empty}`)
    console.log(`  one-sided (1 line):     ${single}`)
    console.log(`  multi-line unbalanced:  ${multi}`)

    // Distribution of diffs to spot recurring patterns (e.g. 1.50 bank fees)
    const byDiff = new Map<string, number>()
    for (const v of bad.filter((b) => b.lineCount > 0)) {
      const key = Math.abs(v.diff).toFixed(2)
      byDiff.set(key, (byDiff.get(key) ?? 0) + 1)
    }
    const topDiffs = [...byDiff.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
    console.log('  most common |diff| amounts:')
    for (const [amount, count] of topDiffs) console.log(`    ${amount} kr × ${count}`)

    // Per-series breakdown
    const bySeries = new Map<string, number>()
    for (const v of bad) {
      const series = v.voucher.replace(/\d+$/, '')
      bySeries.set(series, (bySeries.get(series) ?? 0) + 1)
    }
    console.log('  broken per series:', [...bySeries.entries()].map(([s, n]) => `${s}=${n}`).join(' '))

    const csvEscape = (s: string) => `"${s.replace(/"/g, '""')}"`
    const csv = [
      'voucher;date;diff;line_count;description;lines',
      ...bad.map((v) =>
        [v.voucher, v.date, v.diff.toFixed(2), v.lineCount, csvEscape(v.description), csvEscape(v.lines)].join(';'),
      ),
    ].join('\n')
    const outPath = `scripts/bl-unbalanced-${f.fiscalYear}.csv`
    writeFileSync(outPath, '﻿' + csv, 'utf8')
    console.log(`  full list written to ${outPath}`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
