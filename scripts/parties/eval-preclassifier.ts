/**
 * Parties, phase 0: shadow evaluation of the key pre-classifier against the
 * founder-labelled golden set.
 *
 * WHAT: every counterparty key from the books must be routed before entity
 * resolution: a real party, a category text, payroll, an adjustment, an
 * authority, a bank product, or an intermediary. This script scores two
 * candidate routers against the founder's labels on the same held-out rows:
 *   1. a deterministic rule set (prefixes, lexicon, dominant account), and
 *   2. the model behind getAiService().generateStructured, zero-shot and with
 *      twenty founder examples in the prompt.
 * Agreement is reported as strict label match plus, for the routing decision
 * that matters (party vs not), true-positive and true-negative rates, because
 * failures are rare and raw agreement flatters.
 *
 * SAFETY: read-only. Reads a gitignored JSONL, calls the AI service for the
 * model variants, writes a JSON report next to the input. It never opens a
 * database connection. The golden rows contain customer voucher text; keep
 * the report in dev_docs as well.
 *
 * Usage:
 *   npx tsx scripts/parties/eval-preclassifier.ts \
 *     --golden dev_docs/parties/golden/golden-2026-09-02.jsonl \
 *     --env .env.local [--out <report.json>] [--no-llm] [--batch 25] [--vocab names|full]
 */
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { config as dotenv } from 'dotenv'
import { z } from 'zod'

const LABELS = ['party', 'category', 'payroll', 'adjustment', 'authority', 'bank', 'intermediary', 'unsure'] as const
type Label = (typeof LABELS)[number]

interface GoldenRow {
  id: number
  stratum: string
  k: string
  example: string
  n: number
  cos: number
  acct: string | null
  sek: number
  label: Label
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}
const flag = (name: string) => process.argv.includes(`--${name}`)

const goldenPath = resolve(arg('golden') ?? 'dev_docs/parties/golden/golden-2026-09-02.jsonl')
const envPath = resolve(arg('env') ?? '.env.local')
const outPath = resolve(arg('out') ?? goldenPath.replace(/\.jsonl$/, '') + '.eval.json')
const batchSize = Number(arg('batch') ?? 25)
const runLlm = !flag('no-llm')

dotenv({ path: envPath })

// ── Golden set ──────────────────────────────────────────────────────────────

const rows: GoldenRow[] = readFileSync(goldenPath, 'utf8')
  .split('\n')
  .filter(Boolean)
  .map((line) => JSON.parse(line) as GoldenRow)
  .filter((r) => LABELS.includes(r.label))

// Deterministic split: the 20 rows with the lowest md5(key) are few-shot
// examples; every classifier is scored on the remaining rows only.
const md5 = (s: string) => createHash('md5').update(s).digest('hex')
const ordered = [...rows].sort((a, b) => md5(a.k).localeCompare(md5(b.k)))
const examples = ordered.slice(0, 20)
const exampleIds = new Set(examples.map((r) => r.id))
const evalRows = rows.filter((r) => !exampleIds.has(r.id))

// ── Deterministic router v0 ─────────────────────────────────────────────────

// Lexicon: BAS account names and descriptions for the expense classes plus
// the generic words that voucher text uses for a category without a
// counterpart. Geographic tokens are deliberately NOT in the lexicon: "taxi
// stockholm" reads as a party to the founder, "taxiresor och parkering" does
// not.
import { BAS_REFERENCE } from '@/lib/bookkeeping/bas-reference'

const STOP = new Set([
  'av', 'och', 'för', 'via', 'kort', 'ej', 'moms', 'inkl', 'exkl', 'per', 'utanför', 'inom', 'eu', 'se', 'ab',
  'till', 'mot', 'med', 'från', 'på', 'i', 'en', 'ett', 'den', 'det', 'som', 'om', 'utan', 'the', 'usd', 'eur', 'sek',
])
const GENERIC = [
  'inköp', 'inkp', 'kvitto', 'kvitton', 'fika', 'diesel', 'bensin', 'bränsle', 'försäkring', 'telefon', 'mobil', 'hyra',
  'lokalhyra', 'frakt', 'hosting', 'julklapp', 'frimärken', 'utlägg', 'hotell', 'resa', 'resor', 'resekostnader',
  'biljett', 'biljetter', 'biljettkostnad', 'taxi', 'taxiresor', 'parkering', 'parkeringsavgifter', 'representation',
  'måltidsrepresentation', 'kollektivtrafik', 'kollektivtra', 'kontorsmaterial', 'förbrukning', 'förbrukningsmateriel',
  'frbrukningsmateriel', 'programvara', 'mjukvara', 'licens', 'avgift', 'avgifter', 'traktamente', 'traktamenten',
  'bilersättning', 'material', 'varor', 'tjänster', 'tjnster', 'faktura', 'kostnad', 'kostnader', 'betalning', 'utgift',
  'företagskvitto', 'fretagskvitto', 'fretagskvitton', 'övriga', 'personbilskostnader', 'glykol', 'lastbil', 'verktyg',
  'abonnemang', 'subscription', 'ittjänster', 'itprodukter', 'inrikes', 'utrikes', 'utlandsk', 'utländsk', 'europeisk',
  'annonsering', 'konsultarvoden', 'momspliktig', 'momsfri', 'skattefritt', 'utomlands', 'internet', 'överföring',
  'kortköputtag', 'kortkp', 'uttag', 'avdragsgill', 'avdragbar', 'schablon', 'person', 'deltagare', 'syfte', 'möte',
  'samarbete', 'rapporterad', 'kundfaktura', 'påminnelseavgifter', 'avräkningsnota', 'avrkningsnota', 'fakturaservice',
  'påminnelse', 'ränta', 'dröjsmålsränta', 'porto', 'kontor', 'lokal', 'el', 'vatten', 'värme', 'städning', 'reparation',
  'underhåll', 'service', 'utbildning', 'kurs', 'litteratur', 'tidningar', 'bok', 'böcker', 'gåva', 'gåvor', 'mat',
  'lunch', 'middag', 'kaffe', 'personal', 'friskvård', 'sjukvård', 'arbetskläder', 'skyddskläder',
]
// --vocab names  : BAS account names + GENERIC (default; descriptions name
//                  example vendors such as Google and Facebook, which makes
//                  real parties look generic, the trap the July design found)
// --vocab full   : also BAS description tokens
const vocabMode = arg('vocab') ?? 'names'
const VOCAB = new Set<string>(GENERIC)
for (const a of BAS_REFERENCE) {
  if (a.account_class < 4) continue
  const text = vocabMode === 'full' ? `${a.account_name} ${a.description}` : a.account_name
  for (const t of text.toLowerCase().split(/[^a-zåäöé]+/)) {
    if (t.length >= 3) VOCAB.add(t)
  }
}

const AP_PREFIX = /^(levfakt|levfkt|lev\.?fakt\.?|leverantörsfaktura|leverantorsfaktura|levbet\.?|lev\.?bet\.?)\b/
const PAYROLL = /\b(lön|löner|löne\w*|lneutbetalning|lönebesked|salary|semesterskuld|arbetsgivaravgift\w*|pensionsförsäkring)\b/
const ADJUSTMENT =
  /(periodisering|omföring|omforing|lagerförändring|lagerforandring|nedskrivning|rättelse|rattelse|kostnadsföring|avskrivning|bokslut|kursdiff|valutakurs|eur till sek|omvänd betalningsskyldighet)/
const BANK = /(bankkostnad|bankavgift|banktjänst|baspaket bank|bank årsavg|årsavg|avi överdrag|företagspaket)/
const AUTHORITY = /\b(skatteverket|bolagsverket|transportstyrelsen|försäkringskassan|kronofogden|tullverket|skattekonto|kommun)\b/
const INTERMEDIARY = /\b(klarna|paypal|zettle|izettle|swish|payex|bankgirot|adyen|nets)\b/

function acctNum(a: string | null): number {
  const n = Number(a)
  return Number.isFinite(n) ? n : 0
}

export function ruleLabel(row: { k: string; acct: string | null }): Label {
  const k = row.k
  const acct = acctNum(row.acct)
  if (AP_PREFIX.test(k)) return 'party'
  if (PAYROLL.test(k) || (acct >= 7010 && acct <= 7299)) return 'payroll'
  if (ADJUSTMENT.test(k)) return 'adjustment'
  if (BANK.test(k)) return 'bank'
  if (AUTHORITY.test(k)) return 'authority'
  if (INTERMEDIARY.test(k)) return 'intermediary'
  const content = k
    .split(/\s+/)
    .filter((t) => t.length >= 3 && !/^\d+$/.test(t) && !/^k\d+$/.test(t) && !STOP.has(t))
  if (content.length === 0) return 'unsure'
  return content.every((t) => VOCAB.has(t)) ? 'category' : 'party'
}

// ── Model router ────────────────────────────────────────────────────────────

const SYSTEM = `Du sorterar nycklar från svensk bokföring innan de går vidare till motpartsmatchning.
Varje nyckel är en normaliserad verifikationstext från importerade verifikat, med exempeltext, dominerande BAS-konto, antal verifikat och antal bolag.
Sätt exakt en etikett per nyckel:
- party: en riktig motpart som bolaget betalar eller fakturerar (leverantör, butik, tjänst, kommun som fakturerar). Prefix som "levfakt", "leverantörsfaktura från", "levbet" betyder alltid party.
- category: bara en kostnadstext utan motpart i sig ("inköp av varor", "banktjänster", "fika", "diesel", "hyra momspliktig").
- payroll: lön, förmån, utlägg eller ersättning till en person.
- adjustment: periodisering, kostnadsföring, omföring, lagerförändring, nedskrivning, rättelse, valutaomräkning.
- authority: myndighet som mottagare av en avgift eller skatt (Skatteverket, Transportstyrelsen).
- bank: bankavgifter och bankprodukter.
- intermediary: betalväg eller marknadsplats som inte är den egentliga motparten.
- unsure: går inte att avgöra från texten.
En nyckel som nämner en leverantör men bokförts på ett kategorikonto är ändå party: identiteten avgörs här, kontot kommer från bokföringen.
Svara med exakt de id som frågan innehåller, inga andra.`

const ResponseSchema = z.object({
  labels: z.array(z.object({ id: z.number().int(), label: z.enum(LABELS) })),
})

const jsonSchema = {
  type: 'object',
  properties: {
    labels: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'integer' }, label: { type: 'string', enum: [...LABELS] } },
        required: ['id', 'label'],
        additionalProperties: false,
      },
    },
  },
  required: ['labels'],
  additionalProperties: false,
}

function basName(acct: string | null): string {
  if (!acct) return ''
  const hit = BAS_REFERENCE.find((a) => a.account_number === acct)
  return hit ? hit.account_name : ''
}

function describe(r: GoldenRow): string {
  return `id ${r.id}: nyckel "${r.k}" | exempel "${r.example}" | konto ${r.acct ?? '?'} ${basName(r.acct)} | ${r.n} verifikat | ${r.cos} bolag`
}

async function modelLabels(
  batch: GoldenRow[],
  fewShot: GoldenRow[] | null,
): Promise<{ labels: Map<number, Label>; usage: unknown; model: string }> {
  const { getAiService } = await import('@/lib/ai')
  const service = getAiService()
  const shots = fewShot
    ? `Så här har grundaren märkt tjugo andra nycklar; följ samma bedömning:\n${fewShot
        .map((r) => `${describe(r)} => ${r.label}`)
        .join('\n')}\n\n`
    : ''
  const prompt = `${shots}Märk följande ${batch.length} nycklar:\n${batch.map(describe).join('\n')}`
  let lastError: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const result = await service.generateStructured({
        tier: 'assistant',
        system: SYSTEM,
        prompt,
        maxTokens: 4096,
        schema: { name: 'key_labels', description: 'One label per key id', jsonSchema },
      })
      const parsed = ResponseSchema.parse(result.value)
      const valid = new Set(batch.map((r) => r.id))
      const labels = new Map<number, Label>()
      for (const l of parsed.labels) if (valid.has(l.id) && !labels.has(l.id)) labels.set(l.id, l.label)
      return { labels, usage: result.usage, model: result.model }
    } catch (err) {
      lastError = err
    }
  }
  throw lastError
}

// ── Scoring ─────────────────────────────────────────────────────────────────

interface Score {
  n: number
  strict_agreement: number
  agreement_excluding_founder_unsure: number
  party_tpr: number
  party_tnr: number
  per_label: Record<string, { precision: number | null; recall: number | null; support: number }>
  confusions: { id: number; k: string; founder: Label; predicted: Label | null }[]
}

function score(pred: Map<number, Label | null>, subset: GoldenRow[]): Score {
  let strict = 0
  const decided = subset.filter((r) => r.label !== 'unsure')
  let strictDecided = 0
  let tp = 0, fn = 0, tn = 0, fp = 0
  const per: Record<string, { tp: number; fp: number; fn: number }> = {}
  for (const l of LABELS) per[l] = { tp: 0, fp: 0, fn: 0 }
  const confusions: Score['confusions'] = []
  for (const r of subset) {
    const p = pred.get(r.id) ?? null
    if (p === r.label) strict++
    else confusions.push({ id: r.id, k: r.k, founder: r.label, predicted: p })
    if (p) {
      if (p === r.label) per[p].tp++
      else {
        per[p].fp++
        per[r.label].fn++
      }
    } else per[r.label].fn++
  }
  for (const r of decided) {
    const p = pred.get(r.id) ?? null
    if (p === r.label) strictDecided++
    const isParty = r.label === 'party'
    const predParty = p === 'party'
    if (isParty && predParty) tp++
    else if (isParty && !predParty) fn++
    else if (!isParty && !predParty) tn++
    else fp++
  }
  const r4 = (x: number) => Math.round(x * 10000) / 10000
  const perLabel: Score['per_label'] = {}
  for (const l of LABELS) {
    const { tp: a, fp: b, fn: c } = per[l]
    perLabel[l] = {
      precision: a + b > 0 ? r4(a / (a + b)) : null,
      recall: a + c > 0 ? r4(a / (a + c)) : null,
      support: subset.filter((r) => r.label === l).length,
    }
  }
  return {
    n: subset.length,
    strict_agreement: r4(strict / subset.length),
    agreement_excluding_founder_unsure: r4(strictDecided / decided.length),
    party_tpr: r4(tp / Math.max(1, tp + fn)),
    party_tnr: r4(tn / Math.max(1, tn + fp)),
    per_label: perLabel,
    confusions,
  }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`golden rows ${rows.length}, few-shot examples ${examples.length}, scored rows ${evalRows.length}`)

  const rulePred = new Map<number, Label | null>(evalRows.map((r) => [r.id, ruleLabel(r)]))
  const report: Record<string, unknown> = {
    golden: goldenPath,
    scored_rows: evalRows.length,
    example_ids: [...exampleIds],
    rules_v0: score(rulePred, evalRows),
  }

  if (runLlm) {
    for (const variant of ['zero_shot', 'few_shot'] as const) {
      const pred = new Map<number, Label | null>()
      const usages: unknown[] = []
      let model = ''
      for (let i = 0; i < evalRows.length; i += batchSize) {
        const batch = evalRows.slice(i, i + batchSize)
        const res = await modelLabels(batch, variant === 'few_shot' ? examples : null)
        for (const r of batch) pred.set(r.id, res.labels.get(r.id) ?? null)
        usages.push(res.usage)
        model = res.model
        console.log(`${variant}: batch ${i / batchSize + 1} done (${res.labels.size}/${batch.length} labelled)`)
      }
      report[`model_${variant}`] = { model, usages, ...score(pred, evalRows) }
    }
  }

  writeFileSync(outPath, JSON.stringify(report, null, 2))
  const line = (name: string, s: Score) =>
    `${name.padEnd(16)} strict ${s.strict_agreement}  excl-unsure ${s.agreement_excluding_founder_unsure}  party TPR ${s.party_tpr}  TNR ${s.party_tnr}  (n=${s.n})`
  console.log(line('rules_v0', report.rules_v0 as Score))
  if (runLlm) {
    console.log(line('model_zero_shot', report.model_zero_shot as Score))
    console.log(line('model_few_shot', report.model_few_shot as Score))
  }
  console.log(`report: ${outPath}`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
