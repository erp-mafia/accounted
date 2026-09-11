/**
 * Gemini 3 via Google's OpenAI-compatible endpoint requires each function
 * call's thought_signature to be echoed on the next turn, or the request
 * 400s. The Vercel AI SDK captures that field under the custom provider name
 * (`accounted-byo`) and only serializes `providerOptions.google`, so the
 * signature never goes back on the wire.
 *
 * This fetch wrapper sits below the SDK: it harvests
 * `tool_calls[].extra_content.google.thought_signature` from responses and
 * reattaches it on the next request. Endpoints that never send extra_content
 * (Berget, llama.cpp, Qwen) are unchanged.
 *
 * See https://ai.google.dev/gemini-api/docs/thought-signatures and
 * vercel/ai#18962.
 */

export const SKIP_THOUGHT_SIGNATURE_VALIDATOR = 'skip_thought_signature_validator'

const MAX_STORED_SIGNATURES = 256

type GoogleExtra = { google?: { thought_signature?: string } }

type ToolCallLike = {
  id?: unknown
  extra_content?: GoogleExtra
}

type ChatMessageLike = {
  role?: unknown
  tool_calls?: ToolCallLike[]
}

type ChatRequestLike = {
  messages?: ChatMessageLike[]
}

type ChatCompletionLike = {
  choices?: Array<{
    message?: { tool_calls?: ToolCallLike[] }
    delta?: { tool_calls?: Array<ToolCallLike & { index?: number }> }
  }>
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : null
}

function toolCallId(tc: ToolCallLike): string | null {
  return typeof tc.id === 'string' && tc.id.length > 0 ? tc.id : null
}

function thoughtSignatureOf(tc: ToolCallLike): string | null {
  const sig = tc.extra_content?.google?.thought_signature
  return typeof sig === 'string' && sig.length > 0 ? sig : null
}

function remember(signatures: Map<string, string>, id: string, sig: string): void {
  if (signatures.has(id)) signatures.delete(id)
  signatures.set(id, sig)
  while (signatures.size > MAX_STORED_SIGNATURES) {
    const oldest = signatures.keys().next().value
    if (oldest === undefined) break
    signatures.delete(oldest)
  }
}

export function collectThoughtSignatures(payload: unknown, signatures: Map<string, string>): void {
  const body = asRecord(payload) as ChatCompletionLike | null
  if (!body?.choices) return
  for (const choice of body.choices) {
    for (const tc of choice.message?.tool_calls ?? []) {
      const id = toolCallId(tc)
      const sig = thoughtSignatureOf(tc)
      if (id && sig) remember(signatures, id, sig)
    }
  }
}

function collectStreamingDeltas(
  payload: unknown,
  pending: Map<number, { id?: string; sig?: string }>,
  signatures: Map<string, string>,
): void {
  const body = asRecord(payload) as ChatCompletionLike | null
  if (!body?.choices) return
  for (const choice of body.choices) {
    for (const tc of choice.delta?.tool_calls ?? []) {
      const index = typeof tc.index === 'number' ? tc.index : 0
      const slot = pending.get(index) ?? {}
      const id = toolCallId(tc)
      const sig = thoughtSignatureOf(tc)
      if (id) slot.id = id
      if (sig) slot.sig = sig
      pending.set(index, slot)
      if (slot.id && slot.sig) remember(signatures, slot.id, slot.sig)
    }
  }
}

export function attachThoughtSignatures(body: string, signatures: Map<string, string>): string {
  if (signatures.size === 0) return body
  let parsed: ChatRequestLike
  try {
    parsed = JSON.parse(body) as ChatRequestLike
  } catch {
    return body
  }
  if (!Array.isArray(parsed.messages)) return body

  let changed = false
  for (const message of parsed.messages) {
    if (!Array.isArray(message.tool_calls)) continue
    for (const tc of message.tool_calls) {
      if (thoughtSignatureOf(tc)) continue
      const id = toolCallId(tc)
      const sig =
        (id ? signatures.get(id) : undefined) ?? SKIP_THOUGHT_SIGNATURE_VALIDATOR
      tc.extra_content = {
        ...tc.extra_content,
        google: {
          ...tc.extra_content?.google,
          thought_signature: sig,
        },
      }
      changed = true
    }
  }
  return changed ? JSON.stringify(parsed) : body
}

export function collectThoughtSignaturesFromSse(text: string, signatures: Map<string, string>): void {
  const pending = new Map<number, { id?: string; sig?: string }>()
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const payload = trimmed.slice(5).trim()
    if (payload === '' || payload === '[DONE]') continue
    try {
      collectStreamingDeltas(JSON.parse(payload), pending, signatures)
    } catch {
      // Skip a malformed SSE event; the SDK still sees the original stream.
    }
  }
}

async function harvestResponse(response: Response, signatures: Map<string, string>): Promise<void> {
  let text: string
  try {
    text = await response.clone().text()
  } catch {
    return
  }
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) {
    try {
      collectThoughtSignatures(JSON.parse(trimmed), signatures)
    } catch {
      // Not a chat-completion JSON body.
    }
    return
  }
  if (trimmed.includes('data:')) collectThoughtSignaturesFromSse(text, signatures)
}

/**
 * Wrap `fetch` so Gemini thought signatures survive the SDK's tool loop.
 * One wrapper per provider instance; signatures are keyed by tool-call id.
 */
export function wrapGeminiThoughtSignatureFetch(
  baseFetch: typeof fetch = globalThis.fetch.bind(globalThis),
): typeof fetch {
  const signatures = new Map<string, string>()
  let pendingHarvest: Promise<void> = Promise.resolve()

  return async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    await pendingHarvest

    let nextInit = init
    if (typeof init?.body === 'string') {
      const patched = attachThoughtSignatures(init.body, signatures)
      if (patched !== init.body) nextInit = { ...init, body: patched }
    }

    const response = await baseFetch(input, nextInit)
    // Clone-and-read so the SDK still owns the original body. Await before
    // returning so the next tool-loop request cannot race the harvest.
    pendingHarvest = harvestResponse(response, signatures)
    await pendingHarvest
    return response
  }
}
