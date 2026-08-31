import type { ModelSpec } from '../models'
import { costUsd } from '../models'
import {
  LEDGER_TOOLS,
  executeTool,
  type TrialEnv,
} from '../ledger-env'
import { ASSERTIONS, SEEDS } from '../ledger-tasks'
import { chat, type BenchMessage, type BenchContentPart } from '../providers/index'
import type { LedgerAgentTask, RunRecord } from '../types'
import { BENCH_VERSION, assertDataClassAllowed, loadTasks, nowIso } from '../util'

// Ledger-agent suite: a multi-turn tool loop against a real seeded Postgres
// with the production schema and triggers. Scored on the end state of the
// books (SQL assertions) plus cost. The transcript itself is never graded;
// tool errors (including trigger refusals) are counted as behavioral
// telemetry.

const SYSTEM = `Du är en autonom bokföringsagent för ett svenskt aktiebolag. Du arbetar direkt mot företagets bokföring via verktygen. Dagens datum är 2026-06-30.

Regler:
- Följ svensk bokföringslag: bokförda verifikat får aldrig ändras; rättelse sker genom nytt verifikat (storno/rättelseverifikat).
- Varje verifikat ska balansera (summa debet = summa kredit).
- Använd BAS-kontoplanen.
- När uppdraget är klart: anropa verktyget done med en kort sammanfattning.`

export async function runLedgerAgentTask(
  spec: ModelSpec,
  task: LedgerAgentTask,
): Promise<RunRecord> {
  assertDataClassAllowed(task, spec)
  const seed = SEEDS[task.input.seed]
  const assertions = ASSERTIONS[task.gold.assertions]
  if (!seed) throw new Error(`Unknown seed program ${task.input.seed}`)
  if (!assertions) throw new Error(`Unknown assertion program ${task.gold.assertions}`)

  const startedAt = nowIso()
  const t0 = Date.now()
  const env: TrialEnv = await seed()

  const messages: BenchMessage[] = [{ role: 'user', content: task.input.instruction }]
  let turns = 0
  let inputTokens = 0
  let outputTokens = 0
  let providerCost = 0
  let toolCallCount = 0
  let toolErrorCount = 0
  let invariantRefusals = 0
  let finished = false
  let loopError: string | undefined

  try {
    while (turns < task.input.max_turns) {
      const response = await chat(spec, {
        system: SYSTEM,
        messages,
        tools: LEDGER_TOOLS,
        maxTokens: 4000,
      })
      turns++
      inputTokens += response.usage.inputTokens
      outputTokens += response.usage.outputTokens
      providerCost += response.usage.providerCostUsd ?? 0

      if (response.toolCalls.length === 0) {
        // No tool call and no done: the agent stopped talking. End the trial.
        break
      }

      messages.push({
        role: 'assistant',
        content: response.text,
        toolCalls: response.toolCalls,
      })

      const results: BenchContentPart[] = []
      for (const call of response.toolCalls) {
        if (call.name === 'done') {
          finished = true
        }
        const outcome = await executeTool(
          env,
          call.name,
          (call.input ?? {}) as Record<string, unknown>,
        )
        toolCallCount++
        if (outcome.isError) {
          toolErrorCount++
          // Trigger-sourced refusals carry the Postgres error text of the
          // legal constraint (immutability, balance, period lock).
          if (/posted|balans|balance|lock|lås|immutab|rättelse|correct/i.test(outcome.content)) {
            invariantRefusals++
          }
        }
        results.push({
          type: 'tool_result',
          tool_use_id: call.id,
          content: outcome.content,
          is_error: outcome.isError,
        })
      }
      messages.push({ role: 'user', content: results })
      if (finished) break
    }
  } catch (e) {
    loopError = e instanceof Error ? e.message : String(e)
  }

  const assertionResults = await assertions(env)
  const pass = assertionResults.every((a) => a.pass)

  return {
    benchVersion: BENCH_VERSION,
    suite: 'ledger-agent',
    taskId: task.id,
    model: spec.id,
    provider: spec.provider,
    startedAt,
    durationMs: Date.now() - t0,
    turns,
    usage: {
      inputTokens,
      outputTokens,
      costUsd: providerCost > 0 ? providerCost : costUsd(spec, inputTokens, outputTokens),
    },
    pass,
    score: {
      assertions: assertionResults,
      calledDone: finished,
      toolCalls: toolCallCount,
      toolErrors: toolErrorCount,
      invariantRefusals,
      difficulty: task.difficulty,
    },
    error: loopError,
  }
}

export function loadLedgerAgentTasks(): LedgerAgentTask[] {
  return loadTasks<LedgerAgentTask>('ledger-agent')
}
