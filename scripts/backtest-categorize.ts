/**
 * Backtest the auto-booking cascade against REAL, already-booked transactions.
 *
 * READ-ONLY. For each recent booked expense transaction it: reconstructs the
 * candidate slate + underlag from prod, runs the real selector (against the
 * configured AI backend), and compares the model's proposed account to the
 * account the human actually booked (the expense debit line). Prints per-row
 * detail + an aggregate: overall accuracy, and — the honest signal — accuracy
 * on the cases where the top deterministic candidate was NOT the answer, i.e.
 * where the model had to add value.
 *
 *   cp ~/erp-base/.env.local .   # prod DB + Bedrock, read-only
 *   npx tsx scripts/backtest-categorize.ts [N]
 *   rm .env.local
 *
 * Scope: this script does NOT run on live customer books. It reads each
 * transaction's description, merchant name and matched underlag (via
 * gatherUnderlag) and sends all of it back through the model, which is
 * identifiable bookkeeping content, not anonymous telemetry. The anonymised
 * statistical data the customer agreement covers does not stretch to that,
 * and the DPA limits us to the controller's documented instructions.
 *
 * So the corpus is, by default, sandbox companies (seed data we own). To run
 * against a real company you must name it explicitly:
 *
 *   BACKTEST_COMPANY_IDS=<uuid>,<uuid> npx tsx scripts/backtest-categorize.ts
 *
 * Only name a company that has a written agreement covering evaluation runs.
 * The env var is the record that someone made that call deliberately; an
 * unset run can never touch a customer's books.
 *
 * Leakage caveat: a known vendor's counterparty template may already reflect
 * the very booking under test, inflating the "deterministic nailed it" segment.
 * The "model had to decide" segment below is the leakage-free measure.
 */
import { config } from 'dotenv'
config({ path: '.env.local' })

const N = Number(process.argv[2] ?? 50)
const CONCURRENCY = 4

async function main() {
  const { createClient } = await import('@supabase/supabase-js')
  // Import after dotenv so lib/ai resolves the provider/model from .env.local.
  const { gatherCandidates } = await import('../src/lib/agent/categorize/candidates')
  const { gatherUnderlag } = await import('../src/lib/agent/categorize/underlag')
  const { selectAccount } = await import('../src/lib/agent/categorize/select-account')

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  const supabase = createClient(url, key)

  // Named companies (written agreement required) or, by default, our own
  // sandbox seed data. Never the whole fleet.
  const named = (process.env.BACKTEST_COMPANY_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  let companyIds: string[]
  if (named.length > 0) {
    companyIds = named
    console.log(`Backtesting ${named.length} explicitly named company(ies). Each must be covered by a written agreement.`)
  } else {
    const { data: sandboxes, error: sandboxError } = await supabase
      .from('company_settings')
      .select('company_id')
      .eq('is_sandbox', true)
    if (sandboxError) throw sandboxError
    companyIds = (sandboxes ?? []).map((r) => r.company_id as string)
    console.log(`No BACKTEST_COMPANY_IDS set: backtesting ${companyIds.length} sandbox company(ies).`)
  }
  if (companyIds.length === 0) {
    console.log('\nNothing to backtest. Set BACKTEST_COMPANY_IDS to a company covered by a written agreement, or seed a sandbox company.')
    return
  }

  // Recent booked expense transactions with a counterparty. Queried per chunk
  // of company ids (`.in()` lives in the GET query string), then merged and
  // re-cut to the N most recent overall.
  const CHUNK = 100
  const chunks: string[][] = []
  for (let i = 0; i < companyIds.length; i += CHUNK) chunks.push(companyIds.slice(i, i + CHUNK))
  type Tx = {
    id: string
    company_id: string
    merchant_name: string | null
    description: string | null
    original_description: string | null
    amount: number
    date: string
    currency: string | null
    document_id: string | null
    journal_entry_id: string | null
    created_at: string
  }
  const candidatesByChunk: Tx[] = []
  for (const chunk of chunks) {
    const { data: txs, error } = await supabase
      .from('transactions')
      .select('id, company_id, merchant_name, description, original_description, amount, date, currency, document_id, journal_entry_id, created_at')
      .in('company_id', chunk)
      .not('journal_entry_id', 'is', null)
      .lt('amount', 0)
      .eq('is_business', true)
      .not('merchant_name', 'is', null)
      .order('created_at', { ascending: false })
      .limit(N)
    if (error) throw error
    candidatesByChunk.push(...((txs ?? []) as Tx[]))
  }
  const rows = candidatesByChunk
    .sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0))
    .slice(0, N)
  console.log(`\nBacktesting ${rows.length} booked transactions on ${process.env.BEDROCK_MODEL_ID ?? process.env.AI_MODEL ?? 'the configured model'}…\n`)

  // Ground-truth debit account per journal entry (expense line, not cash/VAT).
  const jeIds = rows.map((r) => r.journal_entry_id).filter(Boolean) as string[]
  const truth = new Map<string, string>()
  for (let i = 0; i < jeIds.length; i += 100) {
    const { data: lines } = await supabase
      .from('journal_entry_lines')
      .select('journal_entry_id, account_number, debit_amount')
      .in('journal_entry_id', jeIds.slice(i, i + 100))
    for (const l of (lines ?? []) as { journal_entry_id: string; account_number: string; debit_amount: number | null }[]) {
      const acct = l.account_number ?? ''
      if (!(Number(l.debit_amount) > 0)) continue
      if (acct.startsWith('19') || acct.startsWith('26') || acct.startsWith('264')) continue // cash + VAT
      const cur = truth.get(l.journal_entry_id)
      if (!cur) truth.set(l.journal_entry_id, acct) // first expense debit line
    }
  }

  const companyCtx = new Map<string, { entityType: string; vatRegistered: boolean }>()
  async function ctxFor(companyId: string) {
    const hit = companyCtx.get(companyId)
    if (hit) return hit
    const [{ data: c }, { data: s }] = await Promise.all([
      supabase.from('companies').select('entity_type').eq('id', companyId).maybeSingle(),
      supabase.from('company_settings').select('vat_registered').eq('company_id', companyId).maybeSingle(),
    ])
    const ctx = { entityType: (c?.entity_type as string) ?? 'enskild_firma', vatRegistered: !!s?.vat_registered }
    companyCtx.set(companyId, ctx)
    return ctx
  }

  interface Result {
    merchant: string
    truth: string | null
    proposed: string | null
    conf: number
    fromCandidate: boolean
    topCandidate: string | null
    hadUnderlag: boolean
    correct: boolean | null
  }
  const results: Result[] = []

  async function run(r: (typeof rows)[number]) {
    const gt = r.journal_entry_id ? truth.get(r.journal_entry_id) ?? null : null
    if (!gt) return
    const ctx = await ctxFor(r.company_id)
    const [candidates, underlag] = await Promise.all([
      gatherCandidates(supabase as never, r.company_id, r as never),
      gatherUnderlag(supabase as never, r.company_id, r.id, r.document_id),
    ])
    const sel = await selectAccount({
      transaction: {
        merchantName: r.merchant_name,
        description: r.description ?? r.original_description ?? '',
        amount: r.amount,
        date: r.date,
        currency: r.currency,
      },
      underlag,
      candidates,
      entityType: ctx.entityType as never,
      vatRegistered: ctx.vatRegistered,
      samples: 1,
    })
    results.push({
      merchant: (r.merchant_name ?? '').slice(0, 22),
      truth: gt,
      proposed: sel.account,
      conf: sel.confidence,
      fromCandidate: sel.fromCandidate,
      topCandidate: candidates[0]?.account ?? null,
      hadUnderlag: underlag.length > 0,
      correct: sel.account ? sel.account === gt : null,
    })
  }

  for (let i = 0; i < rows.length; i += CONCURRENCY) {
    await Promise.all(rows.slice(i, i + CONCURRENCY).map((r) => run(r).catch((e) => console.error('row failed', e?.message))))
    process.stdout.write('.')
  }
  console.log('\n')

  // Per-row.
  for (const r of results) {
    const mark = r.correct === null ? '·' : r.correct ? '✓' : '✗'
    console.log(
      `${mark} ${r.merchant.padEnd(22)} truth=${(r.truth ?? '—').padEnd(6)} pick=${(r.proposed ?? 'review').padEnd(6)} ` +
        `conf=${r.conf.toFixed(2)} ${r.fromCandidate ? 'cand' : 'cat '} ${r.hadUnderlag ? 'underlag' : '        '} topcand=${r.topCandidate ?? '—'}`,
    )
  }

  const scored = results.filter((r) => r.correct !== null)
  const acc = (xs: Result[]) => (xs.length ? (xs.filter((r) => r.correct).length / xs.length) : 0)
  const detWrong = scored.filter((r) => r.topCandidate !== r.truth) // deterministic top candidate was NOT the answer
  const withU = scored.filter((r) => r.hadUnderlag)

  console.log('\n──────── summary ────────')
  console.log(`scored:                 ${scored.length} / ${results.length} (rest = needs_review)`)
  console.log(`overall accuracy:       ${(acc(scored) * 100).toFixed(1)}%`)
  console.log(`  model-decided (top candidate ≠ truth): ${(acc(detWrong) * 100).toFixed(1)}%  (n=${detWrong.length})  ← leakage-free`)
  console.log(`  with underlag:        ${(acc(withU) * 100).toFixed(1)}%  (n=${withU.length})`)
  console.log(`needs_review rate:      ${(((results.length - scored.length) / Math.max(1, results.length)) * 100).toFixed(1)}%`)
  console.log(`reliability (conf ≥0.8): ${(acc(scored.filter((r) => r.conf >= 0.8)) * 100).toFixed(1)}%  (n=${scored.filter((r) => r.conf >= 0.8).length})`)
  console.log(`reliability (conf <0.5): ${(acc(scored.filter((r) => r.conf < 0.5)) * 100).toFixed(1)}%  (n=${scored.filter((r) => r.conf < 0.5).length})`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
