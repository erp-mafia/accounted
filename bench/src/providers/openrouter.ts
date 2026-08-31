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

  const body: Record<string, unknown> = {
    model: spec.apiModel,
    max_tokens: req.maxTokens,
    temperature: 0,
    usage: { include: true },
    messages: toOpenAiMessages(req.system, req.messages),
  }
  if (req.tools && req.tools.length > 0) {
    body.tools = req.tools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    }))
  }

  const res = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`OpenRouter ${res.status}: ${detail.slice(0, 500)}`)
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
