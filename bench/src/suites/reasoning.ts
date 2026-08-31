import type { ModelSpec } from '../models'
import { singleJsonCall } from '../scaffold'
import type { ReasoningTask, RunRecord } from '../types'
import { BENCH_VERSION, assertDataClassAllowed, loadTasks, nowIso } from '../util'

// Reasoning suite: Swedish VAT / bookkeeping-law questions with exactly one
// deterministic answer (a number, an account, a ruta, a date, or one of a
// fixed set of options). No tools, no retrieval: measures what the model
// actually knows about the Swedish rules it would be trusted with.

const SYSTEM = `Du är expert på svensk moms, bokföring och skatteförfarande (ML 2023:200, SFL 2011:1244, BFL 1999:1078, BFNAR). Svara på frågan exakt och kortfattat.

Svara med ENBART ett JSON-objekt: {"answer": <svar>, "confidence": <0.0-1.0>}

- Om frågan gäller ett belopp eller antal: svara med ett tal (utan tusentalsavgränsare, punkt som decimaltecken).
- Om frågan gäller ett datum: svara med ISO-format YYYY-MM-DD.
- Om frågan gäller ett konto, en ruta eller en kod: svara med enbart koden som sträng.
- Om frågan listar svarsalternativ: svara med exakt ett av alternativen, ordagrant.
- Gäller beloppsfrågor svenska kronor om inget annat anges.`

function normalizeString(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, ' ')
}

function gradeAnswer(task: ReasoningTask, answer: unknown): boolean {
  const gold = task.gold
  if (gold.type === 'number') {
    const value =
      typeof answer === 'number'
        ? answer
        : typeof answer === 'string'
          ? Number(answer.replace(/\s/g, '').replace(',', '.'))
          : NaN
    if (!Number.isFinite(value)) return false
    const tol = gold.tolerance ?? 0
    return Math.abs(value - gold.value) <= tol
  }
  const text = typeof answer === 'string' ? answer : String(answer ?? '')
  if (gold.type === 'choice') {
    return normalizeString(text) === normalizeString(gold.value)
  }
  const acceptable = [gold.value, ...(gold.acceptable ?? [])].map(normalizeString)
  return acceptable.includes(normalizeString(text))
}

function userPrompt(task: ReasoningTask): string {
  const gold = task.gold
  if (gold.type === 'choice') {
    return `${task.input.question}\n\nSvarsalternativ: ${gold.options.join(' | ')}`
  }
  return task.input.question
}

export async function runReasoningTask(
  spec: ModelSpec,
  task: ReasoningTask,
): Promise<RunRecord> {
  assertDataClassAllowed(task, spec)
  const startedAt = nowIso()
  const t0 = Date.now()
  const call = await singleJsonCall(spec, SYSTEM, userPrompt(task), 1500)

  const answer = call.parsed?.answer
  const confidenceRaw = call.parsed?.confidence
  const confidence =
    typeof confidenceRaw === 'number' && confidenceRaw >= 0 && confidenceRaw <= 1
      ? confidenceRaw
      : null
  const correct = call.parsed !== null && gradeAnswer(task, answer)

  return {
    benchVersion: BENCH_VERSION,
    suite: 'reasoning',
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
    pass: correct,
    score: {
      parseFailed: call.parsed === null,
      confidence,
      difficulty: task.difficulty,
    },
    answer: call.parsed ?? call.rawText.slice(0, 400),
  }
}

export function loadReasoningTasks(): ReasoningTask[] {
  return loadTasks<ReasoningTask>('reasoning')
}
