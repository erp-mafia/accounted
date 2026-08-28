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
 * Consent: only companies with company_settings.data_analysis_opt_in = true
 * are read (#1346). This script goes beyond booking outcomes: it reads each
 * transaction's description, merchant name and matched underlag (via
 * gatherUnderlag) and sends them to the model again, so the consent copy in
 * messages/*.json (data_analysis.settings_toggle_help) explicitly names
 * "evaluation runs" with exactly those inputs. Do not add inputs here that
 * the copy does not name. Nobody is opted in by default, so an empty run is
 * the expected state until an admin flips the toggle in Inställningar > Företag.
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
  const { gatherCandidates } = await import('../lib/agent/categorize/candidates')
  const { gatherUnderlag } = await import('../lib/agent/categorize/underlag')
  const { selectAccount } = await import('../lib/agent/categorize/select-account')

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY!
  const supabase = createClient(url, key)

  // Consent gate (#1346): only companies that opted in to data analysis.
  const { data: optedIn, error: optedInError } = await supabase
    .from('company_settings')
    .select('company_id')
    .eq('data_analysis_opt_in', true)
  if (optedInError) throw optedInError
  const optedInIds = (optedIn ?? []).map((r) => r.company_id as string)
  if (optedInIds.length === 0) {
    console.log('\nNo company has opted in to data analysis (company_settings.data_analysis_opt_in). Nothing to backtest.')
    return
  }

  // Recent booked expense transactions with a counterparty.
  const { data: txs, error } = await supabase
    .from('transactions')
    .select('id, company_id, merchant_name, description, original_description, amount, date, currency, document_id, journal_entry_id')
    .in('company_id', optedInIds)
    .not('journal_entry_id', 'is', null)
    .lt('amount', 0)
    .eq('is_business', true)
    .not('merchant_name', 'is', null)
    .order('created_at', { ascending: false })
    .limit(N)
  if (error) throw error
  const rows = txs ?? []
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
        description: r.description,
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
