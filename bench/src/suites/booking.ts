import fs from 'node:fs'
import path from 'node:path'
import type { ModelSpec } from '../models'
import { singleJsonCall } from '../scaffold'
import type { BookingTask, RunRecord } from '../types'
import { VAT_TREATMENTS } from '../types'
import { BENCH_VERSION, BENCH_ROOT, assertDataClassAllowed, loadTasks, nowIso } from '../util'

// Booking suite: given one bank transaction plus company context, choose the
// BAS expense/asset account and the VAT treatment. Neutral scaffold: the
// model sees the full BAS 2026 reference chart (numbers + names, committed at
// tasks/booking/context-accounts.txt), the task, and a fixed output contract.
// No candidate cascade, no retrieval: this measures the model, not the
// product pipeline.

const VAT_LEGEND = `Momsbehandlingar (välj exakt en):
- domestic_25: svensk ingående moms 25 % på fakturan
- domestic_12: svensk ingående moms 12 %
- domestic_6: svensk ingående moms 6 %
- no_vat: ingen moms (momsfri tjänst, momsfri aktör, eller ej momsbärande)
- reverse_charge_services: omvänd betalningsskyldighet för köp av tjänst från utlandet (EU eller tredjeland, huvudregeln)
- reverse_charge_goods: unionsinternt förvärv av varor (EU-inköp av varor med VAT-nummer)
- reverse_charge_construction: omvänd byggmoms (byggtjänst mellan byggföretag i Sverige)
- import: import av varor från land utanför EU (importmoms via momsdeklarationen)
- representation_capped: representation där momsavdraget är begränsat enligt schablon/beloppstak
- domestic_25_half_deduction: 25 % moms där endast halva momsen är avdragsgill (t.ex. leasing av personbil)`

function systemPrompt(): string {
  const accounts = fs.readFileSync(
    path.join(BENCH_ROOT, 'tasks', 'booking', 'context-accounts.txt'),
    'utf8',
  )
  return `Du är en svensk redovisningsekonom. Du får en banktransaktion och uppgifter om företaget. Välj vilket konto i BAS-kontoplanen kostnaden/tillgången ska bokföras på, och vilken momsbehandling som gäller.

${VAT_LEGEND}

Svara med ENBART ett JSON-objekt:
{"konto": "<fyrsiffrigt kontonummer>", "moms": "<en av momsbehandlingarna>", "confidence": <0.0-1.0>}

confidence är din egen bedömning av sannolikheten att kontovalet är korrekt.

BAS 2026 kontoplan (nummer och namn):
${accounts}`
}

function userPrompt(task: BookingTask): string {
  const { company, transaction } = task.input
  const lines = [
    `Företag: ${company.business}`,
    `Bolagsform: ${company.entity_type === 'aktiebolag' ? 'aktiebolag' : 'enskild firma'}`,
    `Momsregistrerat: ${company.vat_registered ? 'ja' : 'nej'}`,
    `Bokföringsmetod: ${company.accounting_method === 'invoice' ? 'faktureringsmetoden' : 'kontantmetoden'}`,
    '',
    `Transaktion ${transaction.date}: ${transaction.amount.toFixed(2)} ${transaction.currency}`,
    `Motpart: ${transaction.counterpart}`,
    `Beskrivning: ${transaction.description}`,
  ]
  if (transaction.underlag) {
    lines.push('', `Underlag (text från kvitto/faktura): ${transaction.underlag}`)
  }
  return lines.join('\n')
}

export async function runBookingTask(
  spec: ModelSpec,
  task: BookingTask,
): Promise<RunRecord> {
  assertDataClassAllowed(task, spec)
  const startedAt = nowIso()
  const t0 = Date.now()
  const call = await singleJsonCall(spec, systemPrompt(), userPrompt(task), 8000)

  const konto = typeof call.parsed?.konto === 'string' ? call.parsed.konto.trim() : null
  const moms = typeof call.parsed?.moms === 'string' ? call.parsed.moms.trim() : null
  const confidenceRaw = call.parsed?.confidence
  const confidence =
    typeof confidenceRaw === 'number' && confidenceRaw >= 0 && confidenceRaw <= 1
      ? confidenceRaw
      : null

  const accepted = new Set([task.gold.account, ...(task.gold.acceptable_accounts ?? [])])
  const accountCorrect = konto !== null && accepted.has(konto)
  const vatValid = moms !== null && (VAT_TREATMENTS as string[]).includes(moms)
  const vatCorrect = vatValid && moms === task.gold.vat_treatment

  return {
    benchVersion: BENCH_VERSION,
    suite: 'booking',
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
    pass: accountCorrect && vatCorrect,
    score: {
      accountCorrect,
      vatCorrect,
      exactAccount: konto === task.gold.account,
      parseFailed: call.parsed === null,
      confidence,
      difficulty: task.difficulty,
    },
    answer: call.parsed ?? call.rawText.slice(0, 400),
  }
}

export function loadBookingTasks(): BookingTask[] {
  return loadTasks<BookingTask>('booking').filter((t) => t.id !== 'context')
}
