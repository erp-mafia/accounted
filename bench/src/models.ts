// Model registry for Accounted Ledger-Bench.
//
// Pricing is USD per million tokens (input/output), used to compute the cost
// axis of the leaderboard. Anthropic prices are first-party API rates
// (cached 2026-06: Fable 5 $10/$50, Opus 5 $5/$25, Sonnet 5 $2/$10,
// Haiku 4.5 $1/$5). OpenRouter models report their own cost per request
// (usage.include), which takes precedence over this table when present.
//
// Cost is computed at Anthropic first-party list prices regardless of the
// serving platform (Bedrock partner pricing differs slightly); the cost axis
// is for cross-model comparability, not invoice reconciliation.
//
// `residency` drives the privacy rule: tasks with data_class 'prod-derived'
// may only run on 'eu-bedrock'. All v1 tasks are 'public' (synthetic), so
// every listed model is eligible for them.

export type ProviderKind = 'anthropic' | 'anthropic-bedrock-eu' | 'openrouter'

export interface ModelSpec {
  // Stable id used in results files and the leaderboard.
  id: string
  label: string
  vendor: string
  open_weights: boolean
  provider: ProviderKind
  // Provider-specific model identifier.
  apiModel: string
  vision: boolean
  pricing: { inputPerMTok: number; outputPerMTok: number } | null
  residency: 'anthropic-api' | 'eu-bedrock' | 'openrouter-various'
  enabled: boolean
  notes?: string
}

export const MODELS: ModelSpec[] = [
  {
    id: 'claude-haiku-4-5',
    label: 'Claude Haiku 4.5',
    vendor: 'Anthropic',
    open_weights: false,
    provider: 'anthropic-bedrock-eu',
    apiModel: 'eu.anthropic.claude-haiku-4-5-20251001-v1:0',
    vision: true,
    pricing: { inputPerMTok: 1, outputPerMTok: 5 },
    residency: 'eu-bedrock',
    enabled: true,
  },
  {
    id: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
    vendor: 'Anthropic',
    open_weights: false,
    provider: 'anthropic-bedrock-eu',
    apiModel: 'eu.anthropic.claude-sonnet-4-6',
    vision: true,
    pricing: { inputPerMTok: 3, outputPerMTok: 15 },
    residency: 'eu-bedrock',
    enabled: true,
    notes: 'The model tier production currently runs (BEDROCK_MODEL_ID).',
  },
  {
    id: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    vendor: 'Anthropic',
    open_weights: false,
    provider: 'anthropic-bedrock-eu',
    apiModel: 'eu.anthropic.claude-sonnet-5',
    vision: true,
    pricing: { inputPerMTok: 2, outputPerMTok: 10 },
    residency: 'eu-bedrock',
    enabled: true,
  },
  {
    id: 'claude-opus-5',
    label: 'Claude Opus 5',
    vendor: 'Anthropic',
    open_weights: false,
    provider: 'anthropic-bedrock-eu',
    apiModel: 'eu.anthropic.claude-opus-5',
    vision: true,
    pricing: { inputPerMTok: 5, outputPerMTok: 25 },
    residency: 'eu-bedrock',
    enabled: true,
  },
  {
    id: 'claude-fable-5',
    label: 'Claude Fable 5',
    vendor: 'Anthropic',
    open_weights: false,
    provider: 'anthropic',
    apiModel: 'claude-fable-5',
    vision: true,
    pricing: { inputPerMTok: 10, outputPerMTok: 50 },
    residency: 'anthropic-api',
    enabled: false,
    notes: 'Not on the Bedrock EU account and the direct API key lacks credits; enable once either exists. Task author disclosure: bench tasks were authored with Claude; see methodology.',
  },

  // --- OpenRouter slots (closed + open weights). Disabled until
  // OPENROUTER_API_KEY exists. VERIFY each slug against openrouter.ai/models
  // before first run: slugs below are placeholders written before the key
  // existed and MUST be checked, not trusted.
  {
    id: 'gpt-5-2',
    label: 'GPT-5.2',
    vendor: 'OpenAI',
    open_weights: false,
    provider: 'openrouter',
    apiModel: 'openai/gpt-5.2',
    vision: true,
    pricing: null,
    residency: 'openrouter-various',
    enabled: false,
    notes: 'Verify slug at key time.',
  },
  {
    id: 'gemini-3-pro',
    label: 'Gemini 3 Pro',
    vendor: 'Google',
    open_weights: false,
    provider: 'openrouter',
    apiModel: 'google/gemini-3-pro',
    vision: true,
    pricing: null,
    residency: 'openrouter-various',
    enabled: false,
    notes: 'Verify slug at key time.',
  },
  {
    id: 'llama-4-maverick',
    label: 'Llama 4 Maverick',
    vendor: 'Meta',
    open_weights: true,
    provider: 'openrouter',
    apiModel: 'meta-llama/llama-4-maverick',
    vision: true,
    pricing: null,
    residency: 'openrouter-various',
    enabled: false,
    notes: 'Verify slug at key time.',
  },
  {
    id: 'qwen3-235b',
    label: 'Qwen3 235B',
    vendor: 'Alibaba',
    open_weights: true,
    provider: 'openrouter',
    apiModel: 'qwen/qwen3-235b-a22b',
    vision: false,
    pricing: null,
    residency: 'openrouter-various',
    enabled: false,
    notes: 'Verify slug at key time.',
  },
  {
    id: 'deepseek-v3-2',
    label: 'DeepSeek V3.2',
    vendor: 'DeepSeek',
    open_weights: true,
    provider: 'openrouter',
    apiModel: 'deepseek/deepseek-chat-v3.2',
    vision: false,
    pricing: null,
    residency: 'openrouter-various',
    enabled: false,
    notes: 'Verify slug at key time.',
  },
]

export function getModel(id: string): ModelSpec {
  const m = MODELS.find((x) => x.id === id)
  if (!m) {
    throw new Error(
      `Unknown model '${id}'. Known: ${MODELS.map((x) => x.id).join(', ')}`,
    )
  }
  return m
}

export function costUsd(
  spec: ModelSpec,
  inputTokens: number,
  outputTokens: number,
): number {
  if (!spec.pricing) return 0
  return (
    (inputTokens * spec.pricing.inputPerMTok) / 1_000_000 +
    (outputTokens * spec.pricing.outputPerMTok) / 1_000_000
  )
}
