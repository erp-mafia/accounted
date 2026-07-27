import AnthropicBedrock from '@anthropic-ai/bedrock-sdk'
import { createLogger } from '@/lib/logger'

const log = createLogger('agent-bedrock-client')

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

  // Startup diagnostic: make a hosted misconfiguration visible in the logs
  // instead of it surfacing only as an opaque "request ended without sending
  // any chunks" at stream time. Runs once per cold start (the client is cached).
  // Never logs a secret: only the region, presence booleans, and the 4-char
  // access-key-id PREFIX (AKIA = long-term IAM user key; ASIA = STS/temporary
  // role credential, i.e. a platform-injected one rather than ours).
  if (!awsAccessKey || !awsSecretKey) {
    log.error('agent Bedrock credentials not loaded from env', undefined, {
      region: awsRegion,
      hasAccessKeyId: !!awsAccessKey,
      hasSecretAccessKey: !!awsSecretKey,
      regionFromEnv: !!process.env.AWS_REGION,
    })
  } else {
    log.info('agent Bedrock client init', {
      region: awsRegion,
      keyPrefix: awsAccessKey.slice(0, 4),
      hasSessionToken: !!process.env.AWS_SESSION_TOKEN,
      regionFromEnv: !!process.env.AWS_REGION,
    })
  }

  // When both static keys are present, pass them. Otherwise omit them so the
  // SDK falls back to the AWS credential provider chain (instance profile,
  // IRSA, EKS pod identity, ...). The two-overload SDK refuses a mix.
  cached =
    awsAccessKey && awsSecretKey
      ? new AnthropicBedrock({ awsRegion, awsAccessKey, awsSecretKey })
      : new AnthropicBedrock({ awsRegion })
  return cached
}

// Bedrock model IDs. Region prefix `eu.` keeps inference inside eu-north-1
// (a bare `anthropic.claude-sonnet-5` is rejected: on-demand throughput needs
// the cross-region inference profile). Both are env-overridable so ops can
// swap models without a code deploy.
//
// Both point at Sonnet 5, verified enabled on this Bedrock account. The two
// names are kept because the intents split on them: OPUS_MODEL marks the
// heavy-reasoning intents (supplier-invoice review, VAT review, bokslut) so
// that split survives if a genuinely larger model is enabled here later.
export const OPUS_MODEL = process.env.BEDROCK_OPUS_MODEL_ID || 'eu.anthropic.claude-sonnet-5'
export const SONNET_MODEL = process.env.BEDROCK_SONNET_MODEL_ID || 'eu.anthropic.claude-sonnet-5'

// Reasoning depth for the chat intents.
//
// Sonnet 5 removed the fixed thinking budget: `thinking: {type:'enabled',
// budget_tokens}` is rejected outright ("not supported for this model. Use
// thinking.type.adaptive and output_config.effort"). Depth is now a qualitative
// effort level and the model spends what a turn actually needs.
//
// Levels are `low | medium | high | xhigh | max`. Measured on this account:
// at `medium` a multi-step Swedish VAT question produced no reasoning at all,
// at `xhigh` it produced ~1k characters. Since the point of enabling thinking
// on these intents is that the agent reasons BEFORE it answers rather than
// narrating in the reply, DEEP uses xhigh and STANDARD high.
export const EFFORT_STANDARD = 'high' as const
export const EFFORT_DEEP = 'xhigh' as const

// Output ceilings per tier. Previously derived as budget + 4096; with no budget
// to derive from these are explicit, and there are now three of them because
// max_tokens caps thinking AND the visible reply together: an intent that does
// not think must not inherit a ceiling sized for one that does.
//
// NO_THINKING is the old 4096 reply cap scaled by ~30% for Sonnet 5's new
// tokenizer, which spends that much more on the same Swedish text, so the
// effective reply length is unchanged rather than quietly cut.
export const MAX_TOKENS_NO_THINKING = 5400
export const MAX_TOKENS_STANDARD = 16000
export const MAX_TOKENS_DEEP = 24000
