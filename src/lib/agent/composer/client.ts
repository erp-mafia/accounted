import {
  createAiClient,
  aiCredentialPrefix,
  hasAiCredentials,
  resolveAiProvider,
  toProviderModelId,
  type AiClient,
} from '@/lib/ai/provider'
import { createLogger } from '@/lib/logger'

const log = createLogger('agent-ai-client')

let cached: AiClient | null = null

// Single Claude client for the agent composer + chat loop. Which backend it
// talks to is resolved from the environment by lib/ai/provider.ts:
//
//   - Hosted runs on AWS Bedrock. All Claude traffic stays in eu-north-1,
//     which matters for Swedish accounting data under BFL retention, and
//     failures and quotas show up in one AWS surface rather than two.
//   - Self-hosted deployments with no AWS account run against the direct
//     Anthropic API with a plain ANTHROPIC_API_KEY.
//
// The two SDKs expose the same `messages.create` / `messages.stream` surface,
// which is all this loop uses, so the split is confined to the factory.
//
// Prompt-cache TTL differs between them. We pass
// `cache_control: { type: 'ephemeral', ttl: '1h' }` in the system prompt
// assembly (plan §10); Bedrock ignores the explicit TTL and uses its 5 minute
// default, while the direct API honours the hour. Cache effectiveness on
// multi-minute gaps is therefore better on the direct path; the loop works
// either way.
export async function getAnthropic(): Promise<AiClient> {
  if (cached) return cached

  // Startup diagnostic: make a misconfiguration visible in the logs instead of
  // it surfacing only as an opaque "request ended without sending any chunks"
  // at stream time. Runs once per cold start (the client is cached). Never
  // logs a secret: only the provider, a presence boolean, and the credential's
  // non-secret prefix (see aiCredentialPrefix).
  const provider = resolveAiProvider()
  if (!hasAiCredentials()) {
    log.error('agent AI credentials not loaded from env', undefined, {
      provider,
      hasCredentials: false,
      regionFromEnv: !!process.env.AWS_REGION,
    })
  } else {
    log.info('agent AI client init', {
      provider,
      keyPrefix: aiCredentialPrefix(),
      hasSessionToken: !!process.env.AWS_SESSION_TOKEN,
      regionFromEnv: !!process.env.AWS_REGION,
    })
  }

  cached = await createAiClient()
  return cached
}

// Model ids, written bare and adapted to the resolved provider: Bedrock needs
// the `eu.` inference-profile prefix, the direct API needs it absent. Both stay
// env-overridable so ops can swap models without a code deploy; an override is
// used verbatim, in whichever form the provider it was written for expects.
//
// Both point at Sonnet 5, verified enabled on the hosted Bedrock account. The
// two names are kept because the intents split on them: OPUS_MODEL marks the
// heavy-reasoning intents (supplier-invoice review, VAT review, bokslut) so
// that split survives if a genuinely larger model is enabled here later.
export const OPUS_MODEL =
  toProviderModelId(process.env.BEDROCK_OPUS_MODEL_ID || 'claude-sonnet-5')
export const SONNET_MODEL =
  toProviderModelId(process.env.BEDROCK_SONNET_MODEL_ID || 'claude-sonnet-5')

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

// Output ceilings per tier. max_tokens caps thinking AND the visible reply
// together, and it is a ceiling, not a spend: only generated tokens are billed.
//
// There is no "no thinking" tier. An intent without a `thinking` config sends
// no `thinking` field, and Sonnet 5 then runs adaptive thinking at its default
// effort (high), with the thinking text omitted. That is the same model at the
// same effort as EFFORT_STANDARD, so it gets the same ceiling. The former
// 5400 reply-sized cap let a heavy turn (bokslut.step, crm#1697) spend all of
// it on hidden thinking and end with no text at all. ask-service.ts hit and
// fixed the same thing for the ask surface.
export const MAX_TOKENS_STANDARD = 16000
export const MAX_TOKENS_DEEP = 24000
