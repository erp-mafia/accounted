import fs from 'node:fs'
import path from 'node:path'
import type { ModelSpec } from '../models'
import { singleJsonCall } from '../scaffold'
import type { ExtractionGold, ExtractionTask, RunRecord } from '../types'
import { BENCH_VERSION, BENCH_ROOT, assertDataClassAllowed, loadTasks, nowIso } from '../util'

// Extraction suite: structured fields out of a rendered Swedish document
// (invoice, receipt, credit note). The committed input artifact is a PNG
// rendering of the document: every model receives the identical image.
// Scoring is per-field exact match after normalization, with amounts at
// 0.01 tolerance. The headline metric is field accuracy; `pass` means every
// gold field was correct.

const SYSTEM = `You extract fields from a single Swedish business document (invoice, receipt or credit note) shown as an image.

Rules:
- Amounts use Swedish formats: "1 234,56" means 1234.56. Negative amounts on credit notes stay negative.
- Dates are returned as ISO YYYY-MM-DD.
- orgNumber is the 10-digit Swedish organisationsnummer (format NNNNNN-NNNN as printed). vatNumber is the SE...01 VAT number if printed.
- bankgiro/plusgiro/paymentReference (OCR) exactly as printed.
- roundingAmount is the öresavrundning line if present (can be negative).
- vatBreakdown lists every VAT rate on the document with its base and amount.
- Use null for fields not present on the document.

Respond with ONLY a JSON object:
{"documentKind": "invoice"|"receipt"|"credit_note", "supplierName": string|null, "orgNumber": string|null, "vatNumber": string|null, "bankgiro": string|null, "plusgiro": string|null, "invoiceNumber": string|null, "invoiceDate": string|null, "dueDate": string|null, "paymentReference": string|null, "currency": string, "subtotal": number|null, "vatAmount": number|null, "total": number|null, "roundingAmount": number|null, "servicePeriodStart": string|null, "servicePeriodEnd": string|null, "vatBreakdown": [{"rate": number, "base": number, "amount": number}]}`

function normId(v: unknown): string | null {
  if (v === null || v === undefined) return null
  return String(v).replace(/[\s-]/g, '').toUpperCase() || null
}

function normText(v: unknown): string | null {
  if (v === null || v === undefined) return null
  const s = String(v).trim().toLowerCase().replace(/\s+/g, ' ')
  return s || null
}

function normNumber(v: unknown): number | null {
  if (v === null || v === undefined) return null
  const n =
    typeof v === 'number' ? v : Number(String(v).replace(/\s/g, '').replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

function amountEq(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return a === b
  return Math.abs(a - b) <= 0.011
}

type FieldGrade = { field: string; correct: boolean }

export function gradeExtraction(
  gold: ExtractionGold,
  parsed: Record<string, unknown> | null,
): FieldGrade[] {
  const grades: FieldGrade[] = []
  const p = parsed ?? {}
  const check = (field: string, correct: boolean) => grades.push({ field, correct })

  const textFields: (keyof ExtractionGold)[] = ['documentKind', 'supplierName', 'currency']
  for (const f of textFields) {
    if (gold[f] === undefined) continue
    check(f, normText(p[f]) === normText(gold[f] as unknown))
  }
  const idFields: (keyof ExtractionGold)[] = [
    'orgNumber',
    'vatNumber',
    'bankgiro',
    'plusgiro',
    'invoiceNumber',
    'paymentReference',
  ]
  for (const f of idFields) {
    if (gold[f] === undefined) continue
    check(f, normId(p[f]) === normId(gold[f] as unknown))
  }
  const dateFields: (keyof ExtractionGold)[] = [
    'invoiceDate',
    'dueDate',
    'servicePeriodStart',
    'servicePeriodEnd',
  ]
  for (const f of dateFields) {
    if (gold[f] === undefined) continue
    const got = p[f] === null || p[f] === undefined ? null : String(p[f]).trim()
    check(f, got === (gold[f] as string | null))
  }
  const amountFields: (keyof ExtractionGold)[] = [
    'subtotal',
    'vatAmount',
    'total',
    'roundingAmount',
  ]
  for (const f of amountFields) {
    if (gold[f] === undefined) continue
    check(f, amountEq(normNumber(p[f]), gold[f] as number | null))
  }

  if (gold.vatBreakdown !== undefined) {
    const raw = Array.isArray(p.vatBreakdown) ? (p.vatBreakdown as unknown[]) : []
    const got = raw
      .map((row) => {
        const r = row as Record<string, unknown>
        return {
          rate: normNumber(r.rate),
          base: normNumber(r.base),
          amount: normNumber(r.amount),
        }
      })
      .filter((r) => r.rate !== null)
    const want = [...gold.vatBreakdown]
    let matched = 0
    for (const w of want) {
      const idx = got.findIndex(
        (g) => g.rate === w.rate && amountEq(g.base, w.base) && amountEq(g.amount, w.amount),
      )
      if (idx >= 0) {
        matched++
        got.splice(idx, 1)
      }
    }
    check('vatBreakdown', matched === want.length && got.length === 0)
  }

  return grades
}

export async function runExtractionTask(
  spec: ModelSpec,
  task: ExtractionTask,
): Promise<RunRecord> {
  assertDataClassAllowed(task, spec)
  if (!spec.vision) {
    throw new Error(`Model ${spec.id} has no vision support; extraction suite skipped`)
  }
  const startedAt = nowIso()
  const t0 = Date.now()
  const pngPath = path.join(
    BENCH_ROOT,
    'tasks',
    'extraction',
    'documents',
    task.input.document.replace(/\.pdf$/, '.png'),
  )
  const image = fs.readFileSync(pngPath).toString('base64')

  const call = await singleJsonCall(
    spec,
    SYSTEM,
    [
      { type: 'image_png_base64', data: image },
      { type: 'text', text: 'Extract the fields from this document.' },
    ],
    4000,
  )

  const grades = gradeExtraction(task.gold, call.parsed)
  const correct = grades.filter((g) => g.correct).length
  const fieldAccuracy = grades.length > 0 ? correct / grades.length : 0

  return {
    benchVersion: BENCH_VERSION,
    suite: 'extraction',
    taskId: task.id,
    model: spec.id,
    provider: spec.provider,
    startedAt,
    durationMs: Date.now() - t0,
    turns: call.turns,
    usage: {
      inputTokens: call.inputTokens,
      outputTokens: call.outputTokens,
      costUsd: call.costUsd,
    },
    pass: grades.length > 0 && correct === grades.length,
    score: {
      fieldAccuracy,
      fields: grades,
      parseFailed: call.parsed === null,
      difficulty: task.difficulty,
    },
    answer: call.parsed ?? call.rawText.slice(0, 400),
  }
}

export function loadExtractionTasks(): ExtractionTask[] {
  return loadTasks<ExtractionTask>('extraction')
}
