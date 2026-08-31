import type { ModelSpec } from '../models'
import type {
  BenchContentPart,
  BenchMessage,
  ChatRequest,
  ChatResponse,
} from './index'

// OpenRouter adapter over plain fetch (no SDK dependency). Uses the
// chat/completions surface with OpenAI-style tools and asks OpenRouter to
// include per-request cost in `usage`.

const BASE_URL = process.env.OPENROUTER_BASE_URL ?? 'https://openrouter.ai/api/v1'

// OpenRouter throttles new accounts to 20 requests/minute PER MODEL. A
// per-model gate spaces request starts >= 3.2s apart (about 18 rpm), and a
// 429 still triggers exponential backoff below. Different models proceed in
// parallel: the cap is per model, not per account-wide.
const MIN_INTERVAL_MS = Number(process.env.OPENROUTER_MIN_INTERVAL_MS ?? '3200')
const nextSlot = new Map<string, number>()

async function rateGate(model: string): Promise<void> {
  const now = Date.now()
  const slot = Math.max(nextSlot.get(model) ?? 0, now)
  nextSlot.set(model, slot + MIN_INTERVAL_MS)
  const wait = slot - now
  if (wait > 0) await new Promise((r) => setTimeout(r, wait))
}

interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | unknown[] | null
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[]
  tool_call_id?: string
}

function toOpenAiMessages(system: string, messages: BenchMessage[]): OpenAiMessage[] {
  const out: OpenAiMessage[] = [{ role: 'system', content: system }]
  for (const m of messages) {
    if (m.role === 'assistant') {
      const text = typeof m.content === 'string' ? m.content : ''
      const msg: OpenAiMessage = { role: 'assistant', content: text || null }
      if (m.toolCalls && m.toolCalls.length > 0) {
        msg.tool_calls = m.toolCalls.map((c) => ({
          id: c.id,
          type: 'function',
          function: { name: c.name, arguments: JSON.stringify(c.input ?? {}) },
        }))
      }
      out.push(msg)
      continue
    }
    // User turn: tool results become individual 'tool' messages, other parts
    // become one user message.
    const parts = typeof m.content === 'string'
      ? ([{ type: 'text', text: m.content }] as BenchContentPart[])
      : m.content
    const toolResults = parts.filter((p) => p.type === 'tool_result')
    const rest = parts.filter((p) => p.type !== 'tool_result')
    for (const tr of toolResults) {
      if (tr.type !== 'tool_result') continue
      out.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: tr.content })
    }
    if (rest.length > 0) {
      out.push({
        role: 'user',
        content: rest.map((p) =>
          p.type === 'text'
            ? { type: 'text', text: p.text }
            : { type: 'image_url', image_url: { url: `data:image/png;base64,${(p as { data: string }).data}` } },
        ),
      })
    }
  }
  return out
}

export async function openrouterChat(spec: ModelSpec, req: ChatRequest): Promise<ChatResponse> {
  const apiKey = process.env.OPENROUTER_API_KEY
  if (!apiKey) {
    throw new Error('OPENROUTER_API_KEY is not set; OpenRouter models cannot run yet')
  }

  // Vendor-default sampling (no temperature): several current reasoning
  // models reject sampling parameters, and the Anthropic adapter sends none
  // either, so omitting them everywhere is the uniform policy.
  const body: Record<string, unknown> = {
    model: spec.apiModel,
    max_tokens: req.maxTokens,
    usage: { include: true },
    messages: toOpenAiMessages(req.system, req.messages),
  }
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }))
  }

  let res: Response | null = null
  for (let tryNo = 0; tryNo < 7; tryNo++) {
    await rateGate(spec.apiModel)
    res = await fetch(`${BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://github.com/erp-mafia/accounted',
        'X-Title': 'Accounted Ledger-Bench',
      },
      body: JSON.stringify(body),
    })
    // 402 with in_flight_budget_exhausted is transient (settles as in-flight
    // requests finish); a hard out-of-credits 402 also lands here and gives
    // up after the retries with a clear error.
    if (res.status === 429 || res.status === 402 || res.status >= 500) {
      const retryAfter = Number(res.headers.get('retry-after') ?? '0')
      const backoff = Math.max(retryAfter * 1000, Math.min(60_000, 8000 * 2 ** tryNo))
      await res.text().catch(() => '')
      await new Promise((r) => setTimeout(r, backoff))
      continue
    }
    break
  }
  if (!res || !res.ok) {
    const detail = res ? await res.text().catch(() => '') : ''
    throw new Error(`OpenRouter ${res?.status}: ${detail.slice(0, 500)}`)
  }
  const json = (await res.json()) as {
    choices: {
      message: {
        content: string | null
        tool_calls?: { id: string; function: { name: string; arguments: string } }[]
      }
      finish_reason: string
    }[]
    usage?: { prompt_tokens?: number; completion_tokens?: number; cost?: number }
  }

  const choice = json.choices?.[0]
  const toolCalls = (choice?.message?.tool_calls ?? []).map((c) => {
    let input: unknown = {}
    try {
      input = JSON.parse(c.function.arguments || '{}')
    } catch {
      input = { __unparseable_arguments: c.function.arguments }
    }
    return { id: c.id, name: c.function.name, input }
  })

  return {
    text: choice?.message?.content ?? '',
    toolCalls,
    stopReason: choice?.finish_reason ?? 'unknown',
    usage: {
      inputTokens: json.usage?.prompt_tokens ?? 0,
      outputTokens: json.usage?.completion_tokens ?? 0,
      providerCostUsd: json.usage?.cost,
    },
  }
}
