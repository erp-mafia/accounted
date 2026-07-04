/**
 * One-off cleanup: balance every unbalanced voucher in the BL test company
 * behind the given consent, via BL's
 * PUT /journal/ledgerentry/{journalId}/{journalEntryId}/{journalEntryDate}.
 *
 * BL refuses DELETE on anything but the last voucher of a series, so instead:
 *   method A (preferred): add a counter ledger entry against 0099
 *     "Konvertering" with amount = -diff (probe: entityId 0 = new line)
 *   method B (fallback): update the voucher's first ledger entry so the
 *     voucher sums to zero
 *
 * Each method is probed on ONE voucher and verified with a GET before the
 * mass run. Empty vouchers (0 lines) are left alone: they pass validation.
 *
 * Run: npx tsx --env-file=.env --env-file=.env.local scripts/bl-balance-broken.ts <consentId>
 */
import { createClient } from '@supabase/supabase-js'
import { fetchBjornLundenToken } from '@/lib/providers/bjornlunden/oauth'
import { fetchProviderSieFiles } from '@/extensions/general/arcim-migration/lib/sie-fetcher'
import { parseSIEFile, validateSIEFile } from '@/lib/import/sie-parser'

const BL_BASE_URL = 'https://apigateway.blinfo.se/bla-api/v1/sp'
const DELAY_MS = 125 // ~8 req/s, under BL's 10 req/s limit

const consentId = process.argv[2]
if (!consentId) {
  console.error('Usage: npx tsx --env-file=.env --env-file=.env.local scripts/bl-balance-broken.ts <consentId>')
  console.error('Refusing to run without an explicit consentId: this script writes vouchers to a live BL company.')
  process.exit(1)
}

interface BLLedgerEntry {
  entityId: number
  accountId: string
  amount: number
  costBearerId: string
  costCenterId: string
  date: string
  id: number
  line: number
  projectId: string
  quantity: number
  text: string
  accrual: boolean
}

interface BLJournalEntry {
  entityId: number
  journalId: string
  journalEntryId: number
  journalEntryDate: string
  journalEntryText: string
  ledgerEntries: BLLedgerEntry[]
}

const round2 = (n: number) => Math.round(n * 100) / 100
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

function entrySum(e: BLJournalEntry): number {
  return round2(e.ledgerEntries.reduce((s, l) => s + (l.amount ?? 0), 0))
}

function headers(accessToken: string, userKey: string): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    'User-Key': userKey,
    'Content-Type': 'application/json',
    Accept: 'application/json',
  }
}

async function fetchAllEntries(accessToken: string, userKey: string): Promise<BLJournalEntry[]> {
  const all: BLJournalEntry[] = []
  let page = 1
  let totalPages = 1
  while (page <= totalPages) {
    const params = new URLSearchParams({ page: String(page), rows: '500' })
    const res = await fetch(`${BL_BASE_URL}/journal/entry/batch?${params}`, {
      headers: headers(accessToken, userKey),
      signal: AbortSignal.timeout(60_000),
    })
    if (!res.ok) throw new Error(`batch page ${page} failed: HTTP ${res.status}`)
    const body = await res.json() as { pageRequested: number; totalPages: number; data: BLJournalEntry[] }
    all.push(...(body.data ?? []))
    totalPages = body.totalPages ?? 1
    page++
    await sleep(DELAY_MS)
  }
  return all
}

async function fetchOne(
  accessToken: string,
  userKey: string,
  v: BLJournalEntry,
): Promise<BLJournalEntry> {
  const res = await fetch(
    `${BL_BASE_URL}/journal/entry/${encodeURIComponent(v.journalId)}/${v.journalEntryId}/${v.journalEntryDate}`,
    { headers: headers(accessToken, userKey), signal: AbortSignal.timeout(30_000) },
  )
  if (!res.ok) throw new Error(`GET single entry failed: HTTP ${res.status}`)
  return res.json() as Promise<BLJournalEntry>
}

async function putLedgerEntry(
  accessToken: string,
  userKey: string,
  v: BLJournalEntry,
  body: Partial<BLLedgerEntry>,
): Promise<{ ok: boolean; status: number; body: string }> {
  const res = await fetch(
    `${BL_BASE_URL}/journal/ledgerentry/${encodeURIComponent(v.journalId)}/${v.journalEntryId}/${v.journalEntryDate}`,
    {
      method: 'PUT',
      headers: headers(accessToken, userKey),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30_000),
    },
  )
  const text = await res.text().catch(() => '')
  return { ok: res.ok, status: res.status, body: text.slice(0, 300) }
}

function addLineBody(v: BLJournalEntry, diff: number): Partial<BLLedgerEntry> {
  const maxLine = v.ledgerEntries.reduce((m, l) => Math.max(m, l.line ?? 0), 0)
  return {
    entityId: 0,
    accountId: '0099',
    amount: round2(-diff),
    costBearerId: '',
    costCenterId: '',
    date: v.journalEntryDate,
    line: maxLine + 1,
    projectId: '',
    quantity: 0,
    text: 'Balansering vid migrering (test)',
    accrual: false,
  }
}

function adjustFirstLineBody(v: BLJournalEntry, diff: number): Partial<BLLedgerEntry> {
  const first = v.ledgerEntries[0]!
  return { ...first, amount: round2(first.amount - diff) }
}

async function main() {
  // Either a User-Key GUID passed directly as the 2nd arg, or resolved from
  // the consent in the 1st arg (consents churn on every wizard reconnect).
  let userKey = process.argv[3]
  if (!userKey) {
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
    userKey = tokens[0]!.provider_company_id as string
  }

  const token = await fetchBjornLundenToken(
    process.env.BJORN_LUNDEN_CLIENT_ID!,
    process.env.BJORN_LUNDEN_CLIENT_SECRET!,
  )
  const at = token.access_token

  console.log('Fetching all journal entries via batch API...')
  const entries = await fetchAllEntries(at, userKey)
  const unbalanced = entries.filter((e) => e.ledgerEntries.length > 0 && Math.abs(entrySum(e)) > 0.01)
  const empty = entries.filter((e) => e.ledgerEntries.length === 0).length
  console.log(`${entries.length} vouchers total: ${unbalanced.length} unbalanced (will fix), ${empty} empty (left alone)`)
  if (unbalanced.length === 0) {
    console.log('Nothing to do.')
    return
  }

  // ── Probe method A (add 0099 line) on one voucher ────────────────
  const probe = unbalanced[0]!
  const probeDiff = entrySum(probe)
  console.log(`Probe: ${probe.journalId}${probe.journalEntryId} (${probe.journalEntryDate}, diff ${probeDiff})`)

  let method: 'add' | 'adjust' | null = null
  const addResult = await putLedgerEntry(at, userKey, probe, addLineBody(probe, probeDiff))
  if (addResult.ok) {
    const after = await fetchOne(at, userKey, probe)
    if (Math.abs(entrySum(after)) <= 0.01) {
      method = 'add'
      console.log('Method A (add 0099 counter-line) works: verified balanced via GET.')
    } else {
      console.log(`Method A responded OK but voucher still sums to ${entrySum(after)}: trying method B.`)
    }
  } else {
    console.log(`Method A refused (HTTP ${addResult.status}): ${addResult.body}: trying method B.`)
  }

  if (!method) {
    const fresh = await fetchOne(at, userKey, probe)
    const freshDiff = entrySum(fresh)
    if (Math.abs(freshDiff) > 0.01) {
      const adjResult = await putLedgerEntry(at, userKey, fresh, adjustFirstLineBody(fresh, freshDiff))
      if (!adjResult.ok) {
        console.error(`ABORT: method B also refused (HTTP ${adjResult.status}): ${adjResult.body}`)
        process.exit(1)
      }
      const after = await fetchOne(at, userKey, fresh)
      if (Math.abs(entrySum(after)) > 0.01) {
        console.error(`ABORT: method B responded OK but voucher still sums to ${entrySum(after)}`)
        process.exit(1)
      }
      method = 'adjust'
      console.log('Method B (adjust first line) works: verified balanced via GET.')
    }
  }

  // ── Mass run ─────────────────────────────────────────────────────
  const failures: { voucher: string; status: number; body: string }[] = []
  let done = 1
  for (const v of unbalanced.slice(1)) {
    await sleep(DELAY_MS)
    const diff = entrySum(v)
    const body = method === 'add' ? addLineBody(v, diff) : adjustFirstLineBody(v, diff)
    const result = await putLedgerEntry(at, userKey, v, body)
    if (!result.ok) {
      failures.push({ voucher: `${v.journalId}${v.journalEntryId} (${v.journalEntryDate})`, status: result.status, body: result.body })
    }
    done++
    if (done % 100 === 0) console.log(`  ${done}/${unbalanced.length} (${failures.length} failed)`)
  }

  console.log(`\nDone: ${done - failures.length}/${unbalanced.length} balanced via method ${method}, ${failures.length} failed`)
  if (failures.length > 0) {
    console.log('Failures (first 20):')
    for (const f of failures.slice(0, 20)) console.log(`  ${f.voucher}: HTTP ${f.status} ${f.body}`)
  }

  console.log('\nRe-fetching SIE export to validate...')
  const after = await fetchProviderSieFiles('bjornlunden', at, userKey)
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
