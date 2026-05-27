import type { SupabaseClient } from '@supabase/supabase-js'

// Intent definition shape. One file per intent under lib/agent/intents/<id>.ts
// declares its capture, atom set, tool scope, prompt template, and model.
//
// Plan ref: dev_docs/specialized-agent-plan.md §8.

export interface AgentIntent<Args = Record<string, unknown>, Captured = unknown> {
  // Stable id, e.g. 'transaction.categorization', 'general.help'. Persisted on
  // agent_conversations.intent_id.
  id: string

  // Swedish UI strings.
  buttonLabel: string
  sheetTitle: string

  // Atom-loading mode.
  //   declarative — load the listed horizontal atoms + the company's
  //                 vertical + modifier atoms upfront.
  //   progressive — load metadata only; the agent calls gnubok_load_skill
  //                 to pull a full body on demand.
  // See plan §10 (caching) and §16 ("Atom routing").
  atoms: {
    mode: 'declarative' | 'progressive'
    horizontal: string[] // slug only (no 'horizontal/' prefix), e.g. ['swedish-vat']
    includeCompanyVertical: boolean
    includeCompanyModifiers: boolean
  }

  // Tool names the agent may invoke for this intent. Names must exist in
  // agentToolRegistry; missing tools are silently dropped from the
  // exposed list.
  tools: string[]

  // Anthropic model id. Most intents use Sonnet; heavy reasoning intents
  // override to Opus.
  model: string

  // Extended-thinking budget. When set, run-turn enables a reasoning channel
  // (thinking: { type: 'enabled', budget_tokens }) on every model call in the
  // loop, so the agent reasons before it answers instead of narrating its
  // steps in the visible reply. Omit to disable. budget_tokens must be ≥ 1024.
  thinking?: { budgetTokens: number }

  // Captures the page-context object the prompt template needs. Runs server-
  // side after the user clicks the button. Failures bubble up to the route.
  capture: (args: Args, ctx: CaptureContext) => Promise<Captured>

  // Builds the first-turn user message. The user does NOT see the prompt —
  // only the agent's response to it.
  promptTemplate: (input: PromptTemplateInput<Captured>) => string
}

export interface CaptureContext {
  supabase: SupabaseClient
  userId: string
  companyId: string
}

export interface PromptTemplateInput<Captured> {
  captured: Captured
  profileSummary: string | null
  activeMemory: { content: string }[]
}

// Helper for authoring. Type-narrows on capture/template generics.
export function defineAgentIntent<Args, Captured>(
  intent: AgentIntent<Args, Captured>,
): AgentIntent<Args, Captured> {
  return intent
}
