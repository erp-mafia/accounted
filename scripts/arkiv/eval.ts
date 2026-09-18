/**
 * Arkiv phase 0 harness: reads a directory of trial documents (outside the repo),
 * classifies each one against taxonomy v1 with the relevance gate, extracts a
 * generic typed record with page references, and writes one markdown report.
 *
 *   npx tsx scripts/arkiv/eval.ts --env .env.local --dir ~/Desktop/arkiv-trial --company "Bolaget AB" --org 559000-0000 [--former "Old name AB"]
 *     [--only a,b] [--concurrency 3] [--reclassify] [--reparse]
 *
 * Baseline only: single reading per document, the extraction-tier model for both
 * steps, no two-pass agreement, no local text layer. Real documents never enter
 * the repo; everything is written under <dir>/.out and <dir>/REPORT.md.
 */
import { config as loadEnv } from 'dotenv'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, extname, join, resolve } from 'node:path'
import { z } from 'zod'
import { PDFDocument } from 'pdf-lib'

const args = process.argv.slice(2)
const arg = (name: string, fallback?: string) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const envFile = arg('--env')
if (!envFile) { console.error('--env <file> is required'); process.exit(1) }
loadEnv({ path: resolve(envFile), override: false })
const dir = resolve(arg('--dir', join(process.env.HOME ?? '', 'Desktop', 'arkiv-trial'))!)
const only = arg('--only')?.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean)
const concurrency = Number(arg('--concurrency', '3'))
const reclassify = args.includes('--reclassify')
const reparse = args.includes('--reparse')

// Imported after the env is loaded: the AI config reads process.env at call time,
// so the static import is fine as long as loadEnv() above has run.
import { getAiService, readAiConfig } from '../../lib/ai'
import { extractJsonObject } from '../../lib/ai/json'

/** Models copy verbatim quotes that contain unescaped double quotes; escape a quote that is not followed by a structural character. */
function repairJson(text: string): string {
  let out = '', inString = false, escaped = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inString) {
      if (escaped) { out += ch; escaped = false; continue }
      if (ch === '\\') { out += ch; escaped = true; continue }
      if (ch === '"') {
        let j = i + 1
        while (j < text.length && /\s/.test(text[j])) j++
        const next = text[j]
        if (next === undefined || next === ',' || next === '}' || next === ']' || next === ':') { inString = false; out += ch } else out += '\\"'
        continue
      }
      out += ch; continue
    }
    if (ch === '"') inString = true
    out += ch
  }
  return out
}
const parseJson = (text: string): unknown => {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  const body = (fenced ? fenced[1] : text).trim()
  for (const candidate of [body, repairJson(body), extractJsonObject(text), repairJson(extractJsonObject(text))]) {
    try { const v = JSON.parse(candidate); if (v && typeof v === 'object') return v } catch { /* next */ }
  }
  return null
}

const DOC_TYPES = [
  'supplier_invoice', 'receipt', 'credit_note', 'customer_invoice', 'bank_statement', 'tax_account_statement',
  'agreement.lease', 'agreement.loan', 'agreement.rental', 'agreement.insurance', 'agreement.employment',
  'agreement.shareholder', 'agreement.investment', 'agreement.customer', 'agreement.subscription', 'agreement.other',
  'registration.bolagsverket', 'decision.skatteverket', 'filing.bolagsverket', 'minutes.board', 'minutes.agm',
  'share_subscription_list', 'annual_report', 'other',
] as const

const Classification = z.object({
  doc_type: z.enum(DOC_TYPES),
  confidence: z.number().min(0).max(1),
  language: z.string(),
  pages_seen: z.number().int().nullable(),
  is_multi_document: z.boolean(),
  relevance: z.enum(['relevant', 'ask', 'irrelevant']),
  relevance_reason: z.string(),
  addressed_to: z.string().nullable(),
  summary: z.string(),
  suggested_type: z.string().nullable(),
})
type Classification = z.infer<typeof Classification>

const str = z.preprocess((v) => (v == null ? null : typeof v === 'string' ? v : typeof v === 'number' ? String(v) : JSON.stringify(v)), z.string().nullable())
const num = z.preprocess((v) => (typeof v === 'string' ? Number(v.replace(/[^\d.,-]/g, '').replace(',', '.')) : v), z.number().nullable()).catch(null)
const page = z.preprocess((v) => (typeof v === 'string' ? parseInt(v, 10) : v), z.number().int().nullable()).catch(null)
const list = <T extends z.ZodTypeAny>(item: T, fromMap: (k: string, v: unknown) => unknown) =>
  z.preprocess((v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? Object.entries(v as object).map(([k, x]) => fromMap(k, x)) : []), z.array(item.catch(undefined as never)).transform((a) => a.filter((x) => x !== undefined)))
const Field = z.object({ name: str.transform((v) => v ?? ''), value: str.optional().default(null), page: page.optional().default(null), quote: str.optional().default(null) })
const Record = z.object({
  title: str.transform((v) => v ?? ''),
  parties: list(z.object({ name: str.transform((v) => v ?? ''), org_number: str.optional().default(null), role: str.optional().default(null) }), (k, v) => (v && typeof v === 'object' ? { name: k, ...(v as object) } : { name: k, role: String(v ?? '') })),
  fields: list(Field, (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? { name: k, ...(v as object) } : { name: k, value: v == null ? null : String(v) })),
  dates: list(z.object({ date: str.transform((v) => v ?? ''), what: str.optional().default(null), page: page.optional().default(null) }), (k, v) => ({ date: String(v ?? ''), what: k })),
  amounts: list(z.object({ amount: num, currency: str.optional().default(null), what: str.optional().default(null), page: page.optional().default(null) }), (k, v) => ({ amount: v, what: k })),
  obligations: list(z.object({ kind: str.transform((v) => v ?? ''), amount: num.optional().default(null), currency: str.optional().default(null), recurrence: str.optional().default(null), first_due: str.optional().default(null), page: page.optional().default(null) }), (k, v) => (v && typeof v === 'object' ? { kind: k, ...(v as object) } : { kind: k })),
  would_create: list(z.string(), (k, v) => `${k}: ${String(v)}`),
  uncertain: list(z.string(), (k, v) => `${k}: ${String(v)}`),
})
type Record = z.infer<typeof Record>

// The archive owner, passed on the command line so no company identity lives in the repo.
const COMPANY = { name: arg('--company', 'the company')!, formerName: arg('--former', '')!, orgNumber: arg('--org', 'unknown')! }

const CLASSIFY_SYSTEM = `You classify business documents for a Swedish accounting system. The company that owns this archive is ${COMPANY.name} (organisationsnummer ${COMPANY.orgNumber}), ${COMPANY.formerName ? `formerly named ${COMPANY.formerName}.` : ''}

Taxonomy (choose exactly one doc_type): ${DOC_TYPES.join(', ')}.
Definitions: agreement.* = a signed or to-be-signed contract binding the company (lease of equipment, loan or credit including convertible loans, rental of premises, insurance, employment, shareholder or investment agreements including adherence agreements, customer contracts, subscriptions); registration.bolagsverket = registreringsbevis or an extract from Bolagsverket; filing.bolagsverket = a form or application sent TO Bolagsverket (anmälan, ändringsanmälan); decision.skatteverket = a decision or registration letter from Skatteverket; minutes.board and minutes.agm = styrelseprotokoll and stämmoprotokoll; share_subscription_list = teckningslista; other = anything else.

Relevance: 'relevant' when the document concerns this company's finances, obligations, structure, ownership, people or business. 'ask' when nothing ties it to the company: no amount, no counterparty, no organisation number, no business text; or when it is addressed to a different company. 'irrelevant' only when it is clearly private or unrelated (a holiday photo, a screenshot of a chat). A receipt with an amount is relevant even if it may be private, because it may be an expense claim.

Answer with one JSON object only, no prose, with keys: doc_type, confidence (0 to 1), language (ISO 639-1), pages_seen (integer or null), is_multi_document (true when several separate documents are bundled in one file), relevance, relevance_reason (one sentence, Swedish), addressed_to (the company or person the document is addressed to or concerns, or null), summary (two sentences in Swedish), suggested_type (a short label when doc_type is other, else null).`

function extractionInstruction(docType: string): string {
  const fam = docType.startsWith('agreement.') ? 'agreement' : docType.startsWith('minutes.') ? 'minutes' : docType
  const perType: globalThis.Record<string, string> = {
    agreement: 'For an agreement, fields must include when present: parties and roles, effective date, start date, end date, term, notice period, renewal rule, principal or contract amount, currency, payment period, interest rate, repayment schedule, security or guarantees, conversion terms, governing law, signatures and signing dates. Obligations: every recurring or scheduled payment the company must make or receive.',
    'registration.bolagsverket': 'For a registreringsbevis, fields must include: organisationsnummer, company name, registered office (säte), postal address, registration date, share capital, number of shares, board members with roles, deputies, firmateckning (who may sign), auditor if any, verksamhet (business description), räkenskapsår, and the date the extract was issued.',
    'filing.bolagsverket': 'For a filing to Bolagsverket, fields must include: what is being changed or applied for, the new values, who signed, the date, and any fees.',
    'decision.skatteverket': 'For a Skatteverket decision, fields must include: the decision type (F-skatt, moms, arbetsgivare, preliminärskatt), effective date, registration period (for moms), amounts, and the decision date.',
    minutes: 'For minutes, fields must include: meeting date, place, chair, secretary, attendees and roles, each decision as its own field (dividends, resultatdisposition, share issues, options, board changes, authorisations), and signatures.',
    share_subscription_list: 'For a subscription list, fields must include: the issue it belongs to, price per share, number of shares, each subscriber with the count and amount, subscription period, and totals.',
    supplier_invoice: 'For an invoice, fields must include: supplier name and org number, invoice number, invoice date, due date, currency, net, VAT, total, payment reference, bankgiro or IBAN, line items summarised.',
    receipt: 'For a receipt, fields must include: merchant, date, total, VAT amount and rate, currency, payment method, what was bought, and whether it looks like a business purchase.',
    other: 'Extract the main facts as fields.',
  }
  return `Extract a structured record from this document. ${perType[fam] ?? perType.other}
Every field, date, amount and obligation must carry the page number it was read from (1-based) and fields must carry a short verbatim quote from that page. Use null when something is absent; never invent values. Amounts are numbers with the currency separate. List in would_create what the accounting system should create from this document (for example an agreement record, expected payments, important dates, company facts to reconcile with settings). List in uncertain anything you could not read clearly.
Keep quotes to at most twelve words. Keep the record to the forty most important fields for a long document.
Answer with one JSON object only, no prose, in exactly this shape (arrays, never maps; null for unknown):
{"title": "string", "parties": [{"name": "string", "org_number": "string or null", "role": "string"}], "fields": [{"name": "string", "value": "string or null", "page": 1, "quote": "string or null"}], "dates": [{"date": "YYYY-MM-DD", "what": "string", "page": 1}], "amounts": [{"amount": 0, "currency": "SEK", "what": "string", "page": 1}], "obligations": [{"kind": "string", "amount": 0, "currency": "SEK", "recurrence": "string or null", "first_due": "YYYY-MM-DD or null", "page": 1}], "would_create": ["string"], "uncertain": ["string"]}`
}

type FileEntry = { company: string; file: string; path: string; bytes: Buffer; sha256: string; size: number; kind: 'pdf' | 'image'; mediaType?: 'image/jpeg' | 'image/png' | 'image/webp'; pages: number | null; converted?: string }

async function inventory(): Promise<FileEntry[]> {
  const out: FileEntry[] = []
  for (const company of readdirSync(dir)) {
    const cdir = join(dir, company)
    if (company.startsWith('.') || !statSync(cdir).isDirectory()) continue
    for (const file of readdirSync(cdir)) {
      if (file.startsWith('.') || file === 'labels.json' || file === 'labels.template.json') continue
      const path = join(cdir, file)
      if (!statSync(path).isFile()) continue
      if (only && !only.some((o) => file.toLowerCase().includes(o))) continue
      const ext = extname(file).toLowerCase()
      let bytes = readFileSync(path)
      const sha256 = createHash('sha256').update(bytes).digest('hex')
      const size = bytes.length
      if (ext === '.pdf') {
        let pages: number | null = null
        try { pages = (await PDFDocument.load(bytes, { ignoreEncryption: true })).getPageCount() } catch { pages = null }
        out.push({ company, file, path, bytes, sha256, size, kind: 'pdf', pages })
      } else if (['.jpg', '.jpeg', '.png', '.webp', '.heic', '.heif'].includes(ext)) {
        let converted: string | undefined
        let mediaType: FileEntry['mediaType'] = ext === '.png' ? 'image/png' : ext === '.webp' ? 'image/webp' : 'image/jpeg'
        if (ext === '.heic' || ext === '.heif' || size > 3_500_000) {
          const jpgDir = join(dir, '.out', 'jpg'); mkdirSync(jpgDir, { recursive: true })
          const target = join(jpgDir, `${basename(file, ext)}.jpg`)
          if (!existsSync(target)) execFileSync('sips', ['-s', 'format', 'jpeg', '-Z', '2200', path, '--out', target], { stdio: 'ignore' })
          bytes = readFileSync(target); converted = target; mediaType = 'image/jpeg'
        }
        out.push({ company, file, path, bytes, sha256, size, kind: 'image', mediaType, pages: 1, converted })
      } else {
        console.log(`skip (unsupported in phase 0): ${file}`)
      }
    }
  }
  return out
}

type Result = { entry: Omit<FileEntry, 'bytes'>; duplicateOf?: string; classification?: Classification; record?: Record; raw?: string; errors: string[]; usage: { input: number; output: number }; ms: number }

async function run() {
  const cfg = readAiConfig()
  console.log(`provider=${cfg.provider} configured=${cfg.configured} extraction=${cfg.models.extraction} cheap=${cfg.models.cheap}`)
  if (!cfg.configured) { console.error('AI is not configured in the env file'); process.exit(1) }
  const ai = getAiService()
  const entries = await inventory()
  console.log(`${entries.length} files`)
  const prevPath = join(dir, '.out', 'results.json')
  const prev = new Map<string, Classification>()
  const prevRaw = new Map<string, Result>()
  if (existsSync(prevPath)) for (const r of JSON.parse(readFileSync(prevPath, 'utf8')) as Result[]) { if (r.duplicateOf) continue; if (r.classification && !reclassify) prev.set(r.entry.sha256, r.classification); prevRaw.set(r.entry.sha256, r) }
  const seen = new Map<string, string>()
  const results: Result[] = []
  const queue = [...entries]
  const worker = async () => {
    while (queue.length) {
      const e = queue.shift()!
      const t0 = Date.now()
      const { bytes: _bytes, ...entry } = e
      const r: Result = { entry, errors: [], usage: { input: 0, output: 0 }, ms: 0 }
      const dupe = seen.get(e.sha256)
      if (dupe) { r.duplicateOf = dupe; results.push(r); console.log(`dup   ${e.file} = ${dupe}`); continue }
      seen.set(e.sha256, e.file)
      const document = e.kind === 'pdf' ? { kind: 'pdf' as const, data: e.bytes, fileName: e.file } : { kind: 'image' as const, data: e.bytes, mediaType: e.mediaType! }
      if (reparse) {
        const old = prevRaw.get(e.sha256)
        if (old?.classification) { r.classification = old.classification; r.usage = old.usage; r.ms = old.ms }
        if (old?.raw) { r.raw = old.raw; const rec = Record.safeParse(parseJson(old.raw)); if (rec.success) r.record = rec.data; else r.errors.push('record did not match schema on reparse') }
        else if (old?.record) r.record = old.record
        results.push(r); console.log(`parse ${e.file}: fields ${r.record?.fields.length ?? 'none'}`); continue
      }
      try {
        const cached = prev.get(e.sha256)
        if (cached) r.classification = cached
        else {
          const c = await ai.extractFromDocument({ document, system: CLASSIFY_SYSTEM, instruction: 'Classify this document. JSON only.', maxTokens: 1200 })
          if (!c.ok) throw new Error(`classify skipped: ${c.skipped}`)
          r.usage.input += c.usage.inputTokens ?? 0; r.usage.output += c.usage.outputTokens ?? 0
          const parsed = Classification.safeParse(parseJson(c.text))
          if (!parsed.success) throw new Error(`classification did not match schema: ${parsed.error.issues.map((i) => i.path.join('.') + ' ' + i.message).join('; ')}`)
          r.classification = parsed.data
        }
        const parsed = { data: r.classification! }
        console.log(`class ${e.file} -> ${parsed.data.doc_type} (${parsed.data.confidence}) ${parsed.data.relevance}`)
        if (parsed.data.relevance !== 'irrelevant') {
          const x = await ai.extractFromDocument({ document, system: 'You extract structured records from business documents for a Swedish accounting system. Be precise, cite pages, never invent.', instruction: extractionInstruction(parsed.data.doc_type), maxTokens: (e.pages ?? 1) > 10 ? 14000 : 8000 })
          if (!x.ok) throw new Error(`extract skipped: ${x.skipped}`)
          r.usage.input += x.usage.inputTokens ?? 0; r.usage.output += x.usage.outputTokens ?? 0
          if (x.truncated) r.errors.push('extraction output truncated at maxTokens')
          r.raw = x.text.slice(0, 30000)
          const rec = Record.safeParse(parseJson(x.text))
          if (!rec.success) r.errors.push(`record did not match schema: ${rec.error.issues.slice(0, 5).map((i) => i.path.join('.') + ' ' + i.message).join('; ')}`)
          else r.record = rec.data
        }
      } catch (err) {
        r.errors.push(err instanceof Error ? err.message : String(err))
        console.log(`error ${e.file}: ${r.errors.at(-1)}`)
      }
      r.ms = Date.now() - t0
      results.push(r)
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  const outDir = join(dir, '.out'); mkdirSync(outDir, { recursive: true })
  if (only && existsSync(prevPath)) {
    const old = JSON.parse(readFileSync(prevPath, 'utf8')) as Result[]
    const done = new Set(results.map((r) => r.entry.file))
    for (const o of old) if (!done.has(o.entry.file)) results.push(o)
    results.sort((a, b) => a.entry.file.localeCompare(b.entry.file, 'sv'))
  }
  writeFileSync(join(outDir, 'results.json'), JSON.stringify(results, null, 2))
  writeFileSync(join(dir, 'REPORT.md'), report(results, cfg.models.extraction ?? ''))
  for (const company of new Set(results.map((r) => r.entry.company))) {
    const labels = results.filter((r) => r.entry.company === company && !r.duplicateOf).map((r) => ({ file: r.entry.file, type: r.classification?.doc_type ?? 'other', relevant: r.classification ? r.classification.relevance !== 'irrelevant' : true, fields: {} }))
    writeFileSync(join(dir, company, 'labels.template.json'), JSON.stringify(labels, null, 2))
  }
  console.log(`wrote ${join(dir, 'REPORT.md')}`)
}

function report(results: Result[], model: string): string {
  const uniq = results.filter((r) => !r.duplicateOf)
  const byType = new Map<string, number>()
  for (const r of uniq) byType.set(r.classification?.doc_type ?? 'error', (byType.get(r.classification?.doc_type ?? 'error') ?? 0) + 1)
  const inTok = results.reduce((a, r) => a + r.usage.input, 0), outTok = results.reduce((a, r) => a + r.usage.output, 0)
  const cost = (inTok * 2 + outTok * 10) / 1_000_000
  const lines: string[] = []
  lines.push(`# Arkiv phase 0 baseline report`, ``, `Run: ${new Date().toISOString()} · model: ${model} · files: ${results.length} (${uniq.length} unique, ${results.length - uniq.length} duplicates) · tokens in/out: ${inTok.toLocaleString('sv-SE')} / ${outTok.toLocaleString('sv-SE')} · estimated cost: ${cost.toFixed(2)} USD`, ``)
  lines.push(`Baseline only: one reading per document, no two-pass agreement, no local text layer, page references as the model reports them. Numbers here are the floor every later phase is measured against.`, ``)
  lines.push(`## Summary`, ``, `| Type | Count |`, `|---|---|`)
  for (const [t, n] of [...byType.entries()].sort((a, b) => b[1] - a[1])) lines.push(`| ${t} | ${n} |`)
  const rel = { relevant: 0, ask: 0, irrelevant: 0 }
  for (const r of uniq) if (r.classification) rel[r.classification.relevance]++
  lines.push(``, `Relevance: ${rel.relevant} relevant, ${rel.ask} would be asked "Är du säker på att det här rör bolaget?", ${rel.irrelevant} irrelevant. Errors: ${uniq.filter((r) => r.errors.length).length} documents.`, ``)
  lines.push(`| File | Type | Conf. | Relevance | Pages | Fields | Time |`, `|---|---|---|---|---|---|---|`)
  for (const r of results) {
    if (r.duplicateOf) { lines.push(`| ${r.entry.file} | duplicate of ${r.duplicateOf} | | | | | |`); continue }
    const c = r.classification
    lines.push(`| ${r.entry.file} | ${c?.doc_type ?? 'error'} | ${c ? c.confidence.toFixed(2) : ''} | ${c?.relevance ?? ''} | ${r.entry.pages ?? ''} | ${r.record?.fields.length ?? ''} | ${(r.ms / 1000).toFixed(0)} s |`)
  }
  lines.push(``, `## Documents`, ``)
  for (const r of results) {
    if (r.duplicateOf) continue
    const c = r.classification, rec = r.record
    lines.push(`### ${r.entry.file}`, ``)
    lines.push(`${r.entry.kind} · ${r.entry.pages ?? '?'} page(s) · ${(r.entry.size / 1024).toFixed(0)} kB · sha256 ${r.entry.sha256.slice(0, 12)}${r.entry.converted ? ' · read from a JPEG conversion' : ''}`, ``)
    if (c) {
      lines.push(`**Type:** ${c.doc_type} (${c.confidence.toFixed(2)})${c.suggested_type ? `, suggested: ${c.suggested_type}` : ''} · **Language:** ${c.language} · **Multi-document:** ${c.is_multi_document ? 'yes' : 'no'}`, ``)
      lines.push(`**Relevance:** ${c.relevance}. ${c.relevance_reason}${c.addressed_to ? ` Addressed to: ${c.addressed_to}.` : ''}`, ``)
      lines.push(`${c.summary}`, ``)
    }
    if (rec) {
      lines.push(`**Record:** ${rec.title}`, ``)
      if (rec.parties.length) lines.push(`Parties: ${rec.parties.map((p) => `${p.name}${p.org_number ? ` (${p.org_number})` : ''} as ${p.role}`).join('; ')}`, ``)
      if (rec.fields.length) {
        lines.push(`| Field | Value | Page | Quote |`, `|---|---|---|---|`)
        for (const f of rec.fields) lines.push(`| ${f.name} | ${(f.value ?? '').replace(/\|/g, '/')} | ${f.page ?? ''} | ${(f.quote ?? '').replace(/\|/g, '/').replace(/\s+/g, ' ').slice(0, 90)} |`)
        lines.push(``)
      }
      if (rec.dates.length) lines.push(`Dates: ${rec.dates.map((d) => `${d.date} ${d.what}${d.page ? ` (s. ${d.page})` : ''}`).join('; ')}`, ``)
      if (rec.amounts.length) lines.push(`Amounts: ${rec.amounts.map((a) => `${a.amount.toLocaleString('sv-SE')} ${a.currency} ${a.what}${a.page ? ` (s. ${a.page})` : ''}`).join('; ')}`, ``)
      if (rec.obligations.length) lines.push(`Obligations: ${rec.obligations.map((o) => `${o.kind}${o.amount != null ? ` ${o.amount.toLocaleString('sv-SE')} ${o.currency ?? ''}` : ''}${o.recurrence ? ` ${o.recurrence}` : ''}${o.first_due ? ` from ${o.first_due}` : ''}${o.page ? ` (s. ${o.page})` : ''}`).join('; ')}`, ``)
      if (rec.would_create.length) lines.push(`Would create: ${rec.would_create.join('; ')}`, ``)
      if (rec.uncertain.length) lines.push(`Uncertain: ${rec.uncertain.join('; ')}`, ``)
    }
    if (r.errors.length) lines.push(`Errors: ${r.errors.join(' · ')}`, ``)
  }
  return lines.join('\n')
}

run().catch((err) => { console.error(err); process.exit(1) })
