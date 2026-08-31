// Provider adapters. One neutral request shape, mapped to each API.
//
// Fairness rules (see bench/README.md, Harness):
//  - No per-model prompt variants. The suite prompt is byte-identical.
//  - Reasoning settings are vendor defaults: we do not pass thinking or
//    temperature parameters. (The Claude 5 family rejects sampling params;
//    older models fall back to their own defaults. Recorded per run.)
//  - No server-side fallbacks: a refusal is scored as a failure for the
//    model that refused, never silently rescued by another model.

import type { ModelSpec } from '../models'
import { anthropicChat } from './anthropic'
import { openrouterChat } from './openrouter'

export interface BenchTool {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

export type BenchContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_png_base64'; data: string }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean }

export interface BenchMessage {
  role: 'user' | 'assistant'
  content: BenchContentPart[] | string
  // Assistant tool calls from a previous turn, echoed back verbatim.
  toolCalls?: BenchToolCall[]
}

export interface BenchToolCall {
  id: string
  name: string
  input: unknown
}

export interface ChatRequest {
  system: string
  messages: BenchMessage[]
  tools?: BenchTool[]
  maxTokens: number
}

export interface ChatResponse {
  text: string
  toolCalls: BenchToolCall[]
  stopReason: string
  usage: { inputTokens: number; outputTokens: number; providerCostUsd?: number }
}

export async function chat(spec: ModelSpec, req: ChatRequest): Promise<ChatResponse> {
  if (spec.provider === 'anthropic' || spec.provider === 'anthropic-bedrock-eu') {
    return anthropicChat(spec, req)
  }
  if (spec.provider === 'openrouter') {
    return openrouterChat(spec, req)
  }
  throw new Error(`No adapter for provider ${spec.provider}`)
}
