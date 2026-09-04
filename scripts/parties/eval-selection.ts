/**
 * Parties, phase 0/1: shadow evaluation of the SELECTION step against
 * document-anchored ground truth.
 *
 * WHAT: after blocking, the resolver must decide which of at most six
 * similar keys in the same company are the same party as an anchor key, or
 * none. Ground truth here needs no human: every key in the set carries an
 * org number read by OCR from an invoice linked to its voucher, so two keys
 * are the same party exactly when their org numbers agree. The draw is
 * `draw-selection-gold.sql`; keys that map to several org numbers are
 * excluded because they are ambiguous by construction.
 *
 * Two selectors are scored on the same anchors:
 *   1. rules: a candidate is "same" when its core (AP prefix, supplier number
 *      and digit runs stripped) equals the anchor's core;
 *   2. the model behind getAiService().generateStructured, asked to return the
 *      indices of candidates that are the same organisation, or none.
 * Metrics are pair-level (same / different) precision and recall, plus the
 * anchor-level "none" decision, because a resolver that merges where it
 * should not is the failure mode the July design warned about.
 *
 * SAFETY: read-only. Reads a gitignored JSONL, writes a report next to the
 * input. Never opens a database connection.
 *
 * DATA PROCESSING: the model selector is opt-in (--llm). It sends the voucher
 * key text and account numbers in the gold file to getAiService(), which is
 * the same configured provider the production categorizer already sends the
 * same voucher text to (Claude on AWS Bedrock in the EU on hosted). Run it
 * only with an env file whose AI configuration you have checked; without
 * --llm the script scores the rules selector alone and makes no network call.
 *
 * Usage:
 *   npx tsx scripts/parties/eval-selection.ts \
 *     --gold dev_docs/parties/golden/selection-2026-09-02.jsonl --env .env.local \
 *     [--out <report.json>] [--llm] [--limit 300]
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { config as dotenv } from 'dotenv'
import { z } from 'zod'

interface Cand {
  k: string
  example: string
  n: number
  acct: string | null
  org: string
  sim: number
}
interface Anchor {
  rn: number
  anchor_k: string
  anchor_example: string
  anchor_n: number
  anchor_acct: string | null
  anchor_org: string
  candidates: Cand[]
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const flag = (name: string) => process.argv.includes(`--${name}`)

const goldPath = resolve(arg('gold') ?? 'dev_docs/parties/golden/selection-2026-09-02.jsonl')
const envPath = resolve(arg('env') ?? '.env.local')
const outPath = resolve(arg('out') ?? goldPath.replace(/\.jsonl$/, '') + '.eval.json')
const limit = Number(arg('limit') ?? 300)
const runLlm = flag('llm')
dotenv({ path: envPath })

const anchors: Anchor[] = readFileSync(goldPath, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Anchor)
  .slice(0, limit)

// ── Rules selector ──────────────────────────────────────────────────────────
const AP = /^(levfakt|levfkt|lev\.?fakt\.?|leverantörsfaktura från|leverantörsfaktura|levbet\.?|kvitto|faktura|utgift|inköp)\s+/
const SUFFIX = /\b(ab|aktiebolag|hb|kb|sverige|sweden|ltd|limited|oy|gmbh|inc|sarl|publ|filial)\b/g
export function core(k: string): string {
  return k
    .toLowerCase()
    .replace(AP, '')
    .replace(/\b\d+\b/g, '')
    .replace(SUFFIX, '')
    .replace(/[^a-zåäöé ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .join(' ')
}
function rulesSelect(a: Anchor): number[] {
  const ac = core(a.anchor_k)
  if (!ac) return []
  return a.candidates.map((c, i) => (core(c.k) === ac ? i : -1)).filter((i) => i >= 0)
}

// ── Model selector ──────────────────────────────────────────────────────────
const SYSTEM = `Du avgör identitet mellan motparter i svensk bokföring.
Du får ett ankare (en normaliserad verifikationstext från ett bolags bokföring) och upp till sex kandidater ur samma bolag som liknar det.
Svara med index för varje kandidat som är SAMMA organisation som ankaret, alltså samma juridiska person som skulle ha samma organisationsnummer. Olika bolag i samma koncern, franchisetagare med samma kedjenamn, eller ett företag och dess inkassobolag är INTE samma.
Leverantörsnummer inom parentes, fakturanummer och prefix som "levfakt" eller "leverantörsfaktura från" är brus, inte identitet.
Om ingen kandidat är samma organisation, svara med en tom lista. Gissa inte: hellre tom lista än en felaktig sammanslagning.`

const Out = z.object({ same: z.array(z.number().int().min(1).max(6)) })
const jsonSchema = {
  type: 'object',
  properties: { same: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 6 } } },
  required: ['same'],
  additionalProperties: false,
}

async function modelSelect(a: Anchor): Promise<{ picks: number[]; usage: unknown; model: string }> {
  const { getAiService } = await import('@/lib/ai')
  const service = getAiService()
  const prompt =
    `Ankare: "${a.anchor_k}" (exempel "${a.anchor_example}", konto ${a.anchor_acct ?? '?'}, ${a.anchor_n} verifikat)\n` +
    `Kandidater:\n` +
    a.candidates
      .map((c, i) => `[${i + 1}] "${c.k}" (exempel "${c.example}", konto ${c.acct ?? '?'}, ${c.n} verifikat, textlikhet ${c.sim})`)
      .join('\n') +
    `\nVilka kandidater är samma organisation som ankaret? Svara med index, eller tom lista.`
  let lastErr: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await service.generateStructured({
        tier: 'assistant',
        system: SYSTEM,
        prompt,
        maxTokens: 512,
        schema: { name: 'same_party', description: 'Indices of candidates that are the same organisation', jsonSchema },
      })
      const parsed = Out.parse(r.value)
      const picks = [...new Set(parsed.same.map((i) => i - 1).filter((i) => i >= 0 && i < a.candidates.length))]
      return { picks, usage: r.usage, model: r.model }
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr
}

// ── Scoring ─────────────────────────────────────────────────────────────────
interface Score {
  anchors: number
  pairs: number
  pair_precision: number
  pair_recall: number
  pair_tnr: number
  anchor_exact: number
  none_precision: number
  none_recall: number
  false_merges: { anchor: string; candidate: string; sim: number }[]
  missed: { anchor: string; candidate: string; sim: number }[]
}
function score(picksByAnchor: Map<number, number[]>): Score {
  let tp = 0, fp = 0, fn = 0, tn = 0, exact = 0, pairs = 0
  let noneTp = 0, noneFp = 0, noneFn = 0
  const falseMerges: Score['false_merges'] = []
  const missed: Score['missed'] = []
  for (const a of anchors) {
    const picks = new Set(picksByAnchor.get(a.rn) ?? [])
    const truth = new Set(a.candidates.map((c, i) => (c.org === a.anchor_org ? i : -1)).filter((i) => i >= 0))
    let ok = true
    a.candidates.forEach((c, i) => {
      pairs++
      const p = picks.has(i), t = truth.has(i)
      if (p && t) tp++
      else if (p && !t) { fp++; falseMerges.push({ anchor: a.anchor_k, candidate: c.k, sim: c.sim }) }
      else if (!p && t) { fn++; missed.push({ anchor: a.anchor_k, candidate: c.k, sim: c.sim }) }
      else tn++
      if (p !== t) ok = false
    })
    if (ok) exact++
    const predNone = picks.size === 0, truthNone = truth.size === 0
    if (predNone && truthNone) noneTp++
    else if (predNone && !truthNone) noneFp++
    else if (!predNone && truthNone) noneFn++
  }
  const r4 = (x: number) => Math.round(x * 10000) / 10000
  return {
    anchors: anchors.length,
    pairs,
    pair_precision: r4(tp / Math.max(1, tp + fp)),
    pair_recall: r4(tp / Math.max(1, tp + fn)),
    pair_tnr: r4(tn / Math.max(1, tn + fp)),
    anchor_exact: r4(exact / anchors.length),
    none_precision: r4(noneTp / Math.max(1, noneTp + noneFp)),
    none_recall: r4(noneTp / Math.max(1, noneTp + noneFn)),
    false_merges: falseMerges.slice(0, 40),
    missed: missed.slice(0, 40),
  }
}

async function main() {
  const truthNone = anchors.filter((a) => !a.candidates.some((c) => c.org === a.anchor_org)).length
  console.log(`anchors ${anchors.length}, pairs ${anchors.reduce((s, a) => s + a.candidates.length, 0)}, anchors with no true match ${truthNone}`)
  const rules = new Map<number, number[]>(anchors.map((a) => [a.rn, rulesSelect(a)]))
  const report: Record<string, unknown> = { gold: goldPath, rules_v0: score(rules) }
  if (runLlm) {
    const picks = new Map<number, number[]>()
    const usages: unknown[] = []
    let model = ''
    let i = 0
    for (const a of anchors) {
      const r = await modelSelect(a)
      picks.set(a.rn, r.picks)
      usages.push(r.usage)
      model = r.model
      if (++i % 25 === 0) console.log(`model: ${i}/${anchors.length}`)
    }
    report.model_zero_shot = { model, usages, ...score(picks) }
  }
  writeFileSync(outPath, JSON.stringify(report, null, 2))
  const line = (name: string, s: Score) =>
    `${name.padEnd(16)} pair P ${s.pair_precision} R ${s.pair_recall} TNR ${s.pair_tnr} | anchor exact ${s.anchor_exact} | none P ${s.none_precision} R ${s.none_recall} (anchors ${s.anchors}, pairs ${s.pairs})`
  console.log(line('rules_v0', report.rules_v0 as Score))
  if (runLlm) console.log(line('model_zero_shot', report.model_zero_shot as Score))
  console.log(`report: ${outPath}`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
