/**
 * Measure what the receipt matcher's score means, and write the table
 * `lib/underlag/calibration.ts` reads.
 *
 * Source: every attach_document_to_transaction proposal a human answered.
 * Committed means the human agreed the document belongs to the transaction,
 * rejected means they did not. Almost all of them were staged by agents over
 * MCP and carry no score, so each pair is re-scored here with the current
 * matcher from the stored extraction and the transaction, the same way an
 * arrival run would score it. Precision per score interval is the
 * calibration. Read-only against the database.
 *
 * Known bias, stated so nobody reads the table as gospel: the pairs were
 * chosen by agents, so they are mostly plausible, and a rejection can mean
 * "wrong document" as well as "wrong transaction". The shadow log replaces
 * this table as soon as it holds enough answered rows.
 *
 *   npx tsx scripts/calibrate-matcher.ts            # print the table
 *   npx tsx scripts/calibrate-matcher.ts --write    # also write calibration.json
 *
 * Env is loaded first, then the app modules, so the service client sees it.
 */
import { config } from 'dotenv'
import { writeFileSync } from 'node:fs'
import path from 'node:path'

config({ path: '.env.local' })

const BIN_EDGES = [0.6, 0.65, 0.7, 0.75, 0.8, 0.85, 0.9, 0.95, 1.0]

interface OpRow {
  company_id: string
  status: string
  params: { transaction_id?: string; document_id?: string } | null
}

interface DocRow {
  id: string
  company_id: string
  extracted_data: unknown
}

interface TxRow {
  id: string
  date: string | null
  description: string | null
  merchant_name: string | null
  amount: number | null
  currency: string | null
  amount_sek: number | null
  exchange_rate: number | null
}

function chunk<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size))
  return out
}

async function main(): Promise<void> {
  const { createServiceClientNoCookies } = await import('@/lib/auth/api-keys')
  const { fetchAllRows } = await import('@/lib/supabase/fetch-all')
  const { scoreUnderlagCandidates } = await import('@/lib/agent-context/underlag-candidates')
  const { attachSekTotals } = await import('@/lib/receipt-hunt/fx')
  const supabase = createServiceClientNoCookies()

  const ops = await fetchAllRows<OpRow>((range) =>
    supabase
      .from('pending_operations')
      .select('company_id, status, params')
      .eq('operation_type', 'attach_document_to_transaction')
      .in('status', ['committed', 'rejected'])
      .order('id', { ascending: true })
      .range(range.from, range.to),
  )
  const pairs = ops
    .map((o) => ({
      companyId: o.company_id,
      approved: o.status === 'committed',
      documentId: o.params?.document_id,
      transactionId: o.params?.transaction_id,
    }))
    .filter((p): p is { companyId: string; approved: boolean; documentId: string; transactionId: string } =>
      !!p.documentId && !!p.transactionId,
    )

  const docs = new Map<string, DocRow>()
  for (const part of chunk([...new Set(pairs.map((p) => p.documentId))], 200)) {
    const { data } = await supabase.from('document_attachments').select('id, company_id, extracted_data').in('id', part)
    for (const d of (data ?? []) as DocRow[]) docs.set(d.id, d)
  }
  const txs = new Map<string, TxRow>()
  for (const part of chunk([...new Set(pairs.map((p) => p.transactionId))], 200)) {
    const { data } = await supabase
      .from('transactions')
      .select('id, date, description, merchant_name, amount, currency, amount_sek, exchange_rate')
      .in('id', part)
    for (const t of (data ?? []) as TxRow[]) txs.set(t.id, t)
  }

  // Resolve foreign-currency totals into kronor the way an arrival run does,
  // so a EUR receipt against a SEK charge is scored on its amount too.
  const items = [...docs.values()].map((d) => ({
    id: d.id,
    document_id: d.id,
    extracted_data: d.extracted_data,
    channel_context: null,
  }))
  const withSek = await attachSekTotals(supabase, items)
  const itemById = new Map(withSek.map((i) => [i.id, i]))

  let unscorable = 0
  let belowFloor = 0
  const labelled: Array<{ confidence: number; approved: boolean }> = []
  for (const p of pairs) {
    const item = itemById.get(p.documentId)
    const tx = txs.get(p.transactionId)
    if (!item || !tx || !item.extracted_data) {
      unscorable++
      continue
    }
    const [scored] = scoreUnderlagCandidates(tx, [item] as never[])
    if (!scored) {
      belowFloor++
      continue
    }
    labelled.push({ confidence: scored.confidence, approved: p.approved })
  }

  const bins = []
  for (let i = 0; i < BIN_EDGES.length - 1; i++) {
    const lo = BIN_EDGES[i]
    const hi = BIN_EDGES[i + 1]
    const last = i === BIN_EDGES.length - 2
    const inBin = labelled.filter((r) => r.confidence >= lo && (r.confidence < hi || (last && r.confidence <= hi)))
    const approved = inBin.filter((r) => r.approved).length
    bins.push({ lo, hi, n: inBin.length, precision: inBin.length > 0 ? approved / inBin.length : 0 })
  }

  console.log(`answered pairs: ${pairs.length}; scored: ${labelled.length}; below 0.60 or incomparable: ${belowFloor}; missing rows: ${unscorable}`)
  console.log(`approved among scored: ${labelled.filter((r) => r.approved).length}`)
  console.log('interval      n    precision')
  for (const b of bins) {
    console.log(`${b.lo.toFixed(2)}-${b.hi.toFixed(2)}  ${String(b.n).padStart(4)}  ${(b.precision * 100).toFixed(1)}%`)
  }

  if (process.argv.includes('--write')) {
    const out = {
      generated_at: new Date().toISOString(),
      source:
        'pending_operations attach_document_to_transaction, committed vs rejected, all companies, re-scored with the current matcher',
      bins,
    }
    const target = path.join(process.cwd(), 'lib', 'underlag', 'calibration.json')
    writeFileSync(target, JSON.stringify(out, null, 2) + '\n')
    console.log(`written ${target}`)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
