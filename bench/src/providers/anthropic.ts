import Anthropic from '@anthropic-ai/sdk'
import { AnthropicBedrock } from '@anthropic-ai/bedrock-sdk'
import type { ModelSpec } from '../models'
import type {
  BenchContentPart,
  BenchMessage,
  ChatRequest,
  ChatResponse,
} from './index'

// The client follows the model spec: 'anthropic-bedrock-eu' models always go
// through Bedrock in the EU region (apiModel carries the full inference
// profile id), 'anthropic' models through the first-party API.

let apiClient: Anthropic | null = null
let bedrockClient: AnthropicBedrock | null = null

function getClient(provider: string): Anthropic | AnthropicBedrock {
  if (provider === 'anthropic-bedrock-eu') {
    if (!process.env.AWS_ACCESS_KEY_ID) {
      throw new Error('Bedrock model needs AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY')
    }
    bedrockClient ??= new AnthropicBedrock({
      awsRegion: process.env.AWS_REGION ?? 'eu-north-1',
    })
    return bedrockClient
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('Direct Anthropic model needs ANTHROPIC_API_KEY')
  }
  apiClient ??= new Anthropic()
  return apiClient
}

function toAnthropicContent(parts: BenchContentPart[] | string): unknown {
  if (typeof parts === 'string') return parts
  return parts.map((p) => {
    if (p.type === 'text') return { type: 'text', text: p.text }
    if (p.type === 'image_png_base64') {
      return {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: p.data },
      }
    }
    return {
      type: 'tool_result',
      tool_use_id: p.tool_use_id,
      content: p.content,
      is_error: p.is_error ?? false,
    }
  })
}

function toAnthropicMessages(messages: BenchMessage[]): unknown[] {
  return messages.map((m) => {
    if (m.role === 'assistant' && m.toolCalls && m.toolCalls.length > 0) {
      const blocks: unknown[] = []
      const text = typeof m.content === 'string' ? m.content : ''
      if (text) blocks.push({ type: 'text', text })
      for (const call of m.toolCalls) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input })
      }
      return { role: 'assistant', content: blocks }
    }
    return { role: m.role, content: toAnthropicContent(m.content) }
  })
}

export async function anthropicChat(spec: ModelSpec, req: ChatRequest): Promise<ChatResponse> {
  const client = getClient(spec.provider)

  const params: Record<string, unknown> = {
    model: spec.apiModel,
    max_tokens: req.maxTokens,
    system: req.system,
    messages: toAnthropicMessages(req.messages),
  }
  if (req.tools && req.tools.length > 0) {
    params.tools = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema,
    }))
  }

  const response = (await (client as Anthropic).messages.create(
    params as never,
  )) as Anthropic.Message

  let text = ''
  const toolCalls: ChatResponse['toolCalls'] = []
  for (const block of response.content) {
    if (block.type === 'text') text += block.text
    else if (block.type === 'tool_use') {
      toolCalls.push({ id: block.id, name: block.name, input: block.input })
    }
  }

  return {
    text,
    toolCalls,
    stopReason: response.stop_reason ?? 'unknown',
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
  }
}
