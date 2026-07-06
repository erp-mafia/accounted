import AnthropicBedrock from '@anthropic-ai/bedrock-sdk'

let cached: AnthropicBedrock | null = null

// Single AnthropicBedrock client for the agent composer + chat loop. Matches
// the credential surface the rest of the codebase already uses (see
// extensions/general/invoice-inbox/lib/extract-invoice-fields.ts) so:
//
//   1. There's no separate ANTHROPIC_API_KEY to provision and rotate.
//   2. All Claude traffic stays in eu-north-1: important for Swedish
//      accounting data under BFL retention.
//   3. Failures and quotas show up in one AWS surface, not two.
//
// Trade-off vs. the direct Anthropic API: Bedrock's prompt-cache TTL is
// 5 minutes (default) rather than the 1h the plan §10 specifies. We still
// pass `cache_control: { type: 'ephemeral', ttl: '1h' }` in the system
// prompt assembly: Bedrock currently ignores the explicit TTL and uses 5m.
// Cache effectiveness drops on multi-minute gaps but the loop still works.
// Revisit if/when Bedrock exposes longer TTLs or if cost forces the direct
// API.
export function getAnthropic(): AnthropicBedrock {
  if (cached) return cached
  const awsRegion = process.env.AWS_REGION || 'eu-north-1'
  const awsAccessKey = process.env.AWS_ACCESS_KEY_ID
  const awsSecretKey = process.env.AWS_SECRET_ACCESS_KEY
  // When both static keys are present, pass them. Otherwise omit them so the
  // SDK falls back to the AWS credential provider chain (instance profile,
  // IRSA, EKS pod identity, ...). The two-overload SDK refuses a mix.
  cached =
    awsAccessKey && awsSecretKey
      ? new AnthropicBedrock({ awsRegion, awsAccessKey, awsSecretKey })
      : new AnthropicBedrock({ awsRegion })
  return cached
}

// Bedrock model IDs. Region prefix `eu.` keeps inference inside eu-north-1.
// Both are env-overridable so ops can swap models without a code deploy.
//
// Per plan §14 the composer's atom-selection call should run on Opus 4.7 for
// the higher-stakes selection reasoning. Opus 4.7 is not yet enabled on this
// AWS Bedrock account (403 "not available for this account": request access
// on the AWS console under Bedrock → Model access). For now we point OPUS at
// Sonnet 4.6 so the composer still works; atom selection on Sonnet is still
// good: it's a structured-output call via tool_use forcing, not deep
// reasoning. Flip BEDROCK_OPUS_MODEL_ID back to eu.anthropic.claude-opus-4-7
// once Opus access lands.
export const OPUS_MODEL = process.env.BEDROCK_OPUS_MODEL_ID || 'eu.anthropic.claude-sonnet-4-6'
export const SONNET_MODEL = process.env.BEDROCK_SONNET_MODEL_ID || 'eu.anthropic.claude-sonnet-4-6'

// Extended-thinking budgets (budget_tokens) for the chat intents. These are
// ceilings, not floors: the model spends only what a turn needs, so a generous
// cap improves hard turns (multi-source VAT synthesis, anomaly detection)
// without taxing simple ones. run-turn derives max_tokens = budget + 4096, so
// raising these is safe: no manual max_tokens bookkeeping. Tiered to match the
// model split: DEEP for the Opus / heavy-reasoning intents, STANDARD for the
// rest. Early-stage default favours reasoning quality over token cost; dial
// down here in one place if latency/cost ever bites.
export const THINKING_BUDGET_STANDARD = 6000
export const THINKING_BUDGET_DEEP = 12000
