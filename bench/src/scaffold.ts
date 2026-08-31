import type { ModelSpec } from './models'
import { costUsd } from './models'
import { chat, type BenchContentPart } from './providers/index'
import { extractJsonObject } from './util'

// The neutral single-call scaffold shared by the booking, reasoning and
// extraction suites. Every model gets:
//   1. the same system prompt and user content,
//   2. one attempt, plus exactly one retry if the reply contained no
//      parseable JSON object ("Svara med enbart JSON-objektet."),
//   3. vendor-default reasoning settings (no thinking/temperature overrides).
//
// Returns the parsed object (or null after the retry), plus usage.

export interface SingleCallResult {
  parsed: Record<string, unknown> | null
  rawText: string
  stopReason: string
  turns: number
  inputTokens: number
  outputTokens: number
  costUsd: number
}

export async function singleJsonCall(
  spec: ModelSpec,
  system: string,
  userContent: BenchContentPart[] | string,
  maxTokens: number,
): Promise<SingleCallResult> {
  let inputTokens = 0
  let outputTokens = 0
  let providerCost = 0
  let turns = 0

  const first = await chat(spec, {
    system,
    messages: [{ role: 'user', content: userContent }],
    maxTokens,
  })
  turns++
  inputTokens += first.usage.inputTokens
  outputTokens += first.usage.outputTokens
  providerCost += first.usage.providerCostUsd ?? 0

  let parsed = extractJsonObject(first.text)
  let rawText = first.text
  let stopReason = first.stopReason

  if (!parsed && stopReason !== 'refusal') {
    const second = await chat(spec, {
      system,
      messages: [
        { role: 'user', content: userContent },
        { role: 'assistant', content: first.text || '(tomt svar)' },
        { role: 'user', content: 'Svara med enbart JSON-objektet, utan annan text.' },
      ],
      maxTokens,
    })
    turns++
    inputTokens += second.usage.inputTokens
    outputTokens += second.usage.outputTokens
    providerCost += second.usage.providerCostUsd ?? 0
    parsed = extractJsonObject(second.text)
    rawText = second.text
    stopReason = second.stopReason
  }

  return {
    parsed,
    rawText,
    stopReason,
    turns,
    inputTokens,
    outputTokens,
    costUsd: providerCost > 0 ? providerCost : costUsd(spec, inputTokens, outputTokens),
  }
}
