/**
 * One-off cleanup: delete every broken voucher (empty or unbalanced) in the
 * BL test company behind the given consent, via BL's
 * DELETE /journal/entry/{journalId}/{journalEntryId}/{journalEntryDate}.
 *
 * Probes the first voucher and aborts if BL refuses the delete, then runs the
 * full list at ~8 req/s and re-validates the SIE export at the end.
 *
 * Run: npx tsx --env-file=.env --env-file=.env.local scripts/bl-delete-broken.ts <consentId>
 */
import { createClient } from '@supabase/supabase-js'
import { fetchBjornLundenToken } from '@/lib/providers/bjornlunden/oauth'
import { fetchProviderSieFiles } from '@/extensions/general/arcim-migration/lib/sie-fetcher'
import { parseSIEFile, validateSIEFile } from '@/lib/import/sie-parser'

const BL_BASE_URL = 'https://apigateway.blinfo.se/bla-api/v1/sp'
const DELAY_MS = 125 // ~8 req/s, under BL's 10 req/s limit

const consentId = process.argv[2]
if (!consentId) {
  console.error('Usage: npx tsx --env-file=.env --env-file=.env.local scripts/bl-delete-broken.ts <consentId>')
  console.error('Refusing to run without an explicit consentId: this script deletes vouchers from a live BL company.')
  process.exit(1)
}

interface BrokenVoucher {
  series: string
  number: number
  date: string // yyyy-MM-dd as written in the SIE file
  lineCount: number
  diff: number
}

function isoLocal(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function deleteVoucher(
  accessToken: string,
  userKey: string,
  v: BrokenVoucher,
): Promise<{ ok: boolean; status: number; body: string }> {
  const url = `${BL_BASE_URL}/journal/entry/${encodeURIComponent(v.series)}/${v.number}/${v.date}`
  const response = await fetch(url, {
    method: 'DELETE',
    headers: {
      Authorization: `Bearer ${accessToken}`,
      'User-Key': userKey,
    },
    signal: AbortSignal.timeout(30_000),
  })
  const body = response.ok ? '' : await response.text().catch(() => '')
  return { ok: response.ok, status: response.status, body }
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

  console.log('Fetching fresh SIE export to compute the broken-voucher list...')
  const { files } = await fetchProviderSieFiles('bjornlunden', token.access_token, userKey)
  const broken: BrokenVoucher[] = []
  for (const f of files) {
    const parsed = parseSIEFile(f.rawContent)
    for (const v of parsed.vouchers) {
      const diff = Math.round(v.lines.reduce((s, l) => s + l.amount, 0) * 100) / 100
      if (Math.abs(diff) > 0.01 || v.lines.length === 0) {
        broken.push({
          series: v.series,
          number: v.number,
          date: isoLocal(v.date),
          lineCount: v.lines.length,
          diff,
        })
      }
    }
  }

  console.log(`${broken.length} broken vouchers to delete`)
  if (broken.length === 0) {
    console.log('Nothing to do.')
    return
  }

  // Probe with the first voucher: abort if BL refuses deletes
  const probe = broken[0]!
  console.log(`Probe delete: ${probe.series}${probe.number} (${probe.date})...`)
  const probeResult = await deleteVoucher(token.access_token, userKey, probe)
  if (!probeResult.ok) {
    console.error(`ABORT: BL refused the probe delete (HTTP ${probeResult.status}): ${probeResult.body}`)
    process.exit(1)
  }
  console.log('Probe OK: deleting the rest...')

  const failures: { voucher: string; status: number; body: string }[] = []
  let done = 1
  for (const v of broken.slice(1)) {
    await sleep(DELAY_MS)
    const result = await deleteVoucher(token.access_token, userKey, v)
    if (!result.ok) {
      failures.push({ voucher: `${v.series}${v.number} (${v.date})`, status: result.status, body: result.body.slice(0, 200) })
    }
    done++
    if (done % 100 === 0) console.log(`  ${done}/${broken.length} (${failures.length} failed)`)
  }

  console.log(`\nDone: ${done - failures.length}/${broken.length} deleted, ${failures.length} failed`)
  if (failures.length > 0) {
    console.log('Failures (first 20):')
    for (const f of failures.slice(0, 20)) console.log(`  ${f.voucher}: HTTP ${f.status} ${f.body}`)
  }

  console.log('\nRe-fetching SIE export to validate...')
  const after = await fetchProviderSieFiles('bjornlunden', token.access_token, userKey)
  for (const f of after.files) {
    const parsed = parseSIEFile(f.rawContent)
    const validation = validateSIEFile(parsed)
    console.log(`fiscal year ${f.fiscalYear}: ${parsed.vouchers.length} vouchers, valid=${validation.valid}`)
    if (validation.errors.length) console.log('remaining errors:\n- ' + validation.errors.slice(0, 5).join('\n- '))
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
