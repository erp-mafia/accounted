// Model registry for Accounted Ledger-Bench.
//
// Pricing is USD per million tokens (input/output), used to compute the cost
// axis of the leaderboard. Anthropic prices are first-party API rates
// (cached 2026-06: Fable 5 $10/$50, Opus 5 $5/$25, Sonnet 5 $2/$10,
// Haiku 4.5 $1/$5). OpenRouter models report their own cost per request
// (usage.include), which takes precedence over this table when present.
//
// Cost convention (v1.3, verified 2026-08-31 against vendor pricing pages):
// every model is priced at its VENDOR's first-party API list price, standard
// tier, no cache/batch/promo discounts. Open-weights models without a vendor
// API are priced at a named serving provider (Fireworks, following Ramp's
// convention), or the OpenRouter median where Fireworks does not list the
// model (stated in notes). The cost axis is for cross-model comparability,
// not invoice reconciliation.
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

  // --- OpenRouter models (closed + open weights). Slugs VERIFIED against
  // the live /api/v1/models catalog on 2026-08-31; pricing from the same
  // catalog (fallback only: the adapter asks OpenRouter to report the actual
  // request cost, which takes precedence).
  {
    id: 'gpt-5-6-terra-pro',
    label: 'GPT-5.6 Terra Pro',
    vendor: 'OpenAI',
    open_weights: false,
    provider: 'openrouter',
    apiModel: 'openai/gpt-5.6-terra-pro',
    vision: true,
    pricing: { inputPerMTok: 2, outputPerMTok: 12 },
    residency: 'openrouter-various',
    enabled: true,
  },
  {
    id: 'gpt-5-6-luna',
    label: 'GPT-5.6 Luna',
    vendor: 'OpenAI',
    open_weights: false,
    provider: 'openrouter',
    apiModel: 'openai/gpt-5.6-luna',
    vision: true,
    pricing: { inputPerMTok: 0.2, outputPerMTok: 1.2 },
    residency: 'openrouter-various',
    enabled: true,
  },
  {
    id: 'gemini-3-1-pro',
    label: 'Gemini 3.1 Pro',
    vendor: 'Google',
    open_weights: false,
    provider: 'openrouter',
    apiModel: 'google/gemini-3.1-pro-preview',
    vision: true,
    pricing: { inputPerMTok: 2, outputPerMTok: 12 },
    residency: 'openrouter-various',
    enabled: true,
  },
  {
    id: 'grok-4-6',
    label: 'Grok 4.6',
    vendor: 'xAI',
    open_weights: false,
    provider: 'openrouter',
    apiModel: 'x-ai/grok-4.6',
    vision: true,
    pricing: { inputPerMTok: 2, outputPerMTok: 6 },
    residency: 'openrouter-various',
    enabled: true,
  },
  {
    id: 'deepseek-v4-pro',
    label: 'DeepSeek V4 Pro',
    vendor: 'DeepSeek',
    open_weights: true,
    provider: 'openrouter',
    apiModel: 'deepseek/deepseek-v4-pro-0813',
    vision: false,
    pricing: { inputPerMTok: 0.435, outputPerMTok: 0.87 },
    residency: 'openrouter-various',
    enabled: true,
    notes: 'Vendor list (DeepSeek API); OpenRouter serves at a markup.',
  },
  {
    id: 'qwen3-8-2-4t',
    label: 'Qwen3.8 2.4T',
    vendor: 'Alibaba',
    open_weights: true,
    provider: 'openrouter',
    apiModel: 'qwen/qwen3.8-2.4t-a95b',
    vision: false,
    pricing: { inputPerMTok: 2, outputPerMTok: 6 },
    residency: 'openrouter-various',
    enabled: true,
  },
  {
    id: 'llama-4-maverick',
    label: 'Llama 4 Maverick',
    vendor: 'Meta',
    open_weights: true,
    provider: 'openrouter',
    apiModel: 'meta-llama/llama-4-maverick',
    vision: true,
    pricing: { inputPerMTok: 0.2, outputPerMTok: 0.7 },
    residency: 'openrouter-various',
    enabled: true,
    notes: 'No vendor API; not listed at Fireworks; OpenRouter median, stated as such.',
  },
  {
    id: 'kimi-k3',
    label: 'Kimi K3',
    vendor: 'Moonshot',
    open_weights: true,
    provider: 'openrouter',
    apiModel: 'moonshotai/kimi-k3',
    vision: true,
    pricing: { inputPerMTok: 3, outputPerMTok: 15 },
    residency: 'openrouter-various',
    enabled: true,
  },
  {
    id: 'glm-5-3-flash',
    label: 'GLM 5.3 Flash',
    vendor: 'Z.ai',
    open_weights: true,
    provider: 'openrouter',
    apiModel: 'z-ai/glm-5.3-flash',
    vision: true,
    pricing: { inputPerMTok: 0.15, outputPerMTok: 0.5 },
    residency: 'openrouter-various',
    enabled: true,
    notes: 'Z.ai list price; the halved launch promo (to 2026-09-09) is not used.',
  },
  {
    id: 'gpt-oss-120b',
    label: 'GPT-OSS-120B',
    vendor: 'OpenAI',
    open_weights: true,
    provider: 'openrouter',
    apiModel: 'openai/gpt-oss-120b',
    vision: false,
    pricing: { inputPerMTok: 0.15, outputPerMTok: 0.6 },
    residency: 'openrouter-various',
    enabled: true,
    notes: 'No vendor API; priced at Fireworks list (Ramp convention).',
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
