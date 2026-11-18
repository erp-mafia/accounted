import type { SupabaseClient } from '@supabase/supabase-js'
import { getAiService, type AiChatTurn, type AiProgressEvent, type AiToolDef } from '@/lib/ai'
import { createLogger } from '@/lib/logger'
import { companyProfileLine } from '@/lib/agent/ask/ask-service'
import { EmptyModelAnswerError, truncatedAnswerNote } from '@/lib/agent/ask/errors'
import { buildLedgerTools, LEDGER_READ_TOOLS } from '@/lib/agent/ask/ledger-tools'
import { buildAssistantSnapshot } from '@/lib/agent/ask/snapshot'
import { loadNavGateContext, loadUiLabels, renderUiGrounding, type UiMapInput } from '@/lib/agent/ask/ui-map'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import type { Locale } from '@/i18n/config'
import { buildAppTools, handoffTool, type HandoffOffer } from './app-tools'
import { loadMessageTree, loadPageTextIndex } from './page-texts'
import { supportSystemPrompt } from './prompt'
import { supportAssistantEffort } from './rollout'

const log = createLogger('agent.support')

/**
 * The support assistant's answer to one question.
 *
 * The same engine as the old question box (lib/agent/ask): one metered call
 * through the provider-agnostic AI layer, a bounded read-only tool loop, the
 * company's gated menu in the prompt. What it adds is what a support answer
 * needs: the texts on the pages (read_page, find_in_app), a way to say "a
 * person should take this" (offer_human_support), the answer streamed while
 * it is written, and a prompt the prompt cache can share between companies.
 *
 * It never books: no write or staging tool is attached, here or in
 * buildLedgerTools.
 */

export interface SupportAskRequest {
  supabase: SupabaseClient
  companyId: string
  userId: string
  question: string
  /** The app path the user asked from. */
  route?: string
  locale?: Locale
  /** The conversation the turn belongs to: the tool actor id, for the audit trail. */
  conversationId?: string
  /** Earlier turns of the conversation, oldest first (lib/agent/ask/persist.ts loadChatHistory). */
  history?: AiChatTurn[]
  /** The answer as it is written, and which tools the assistant reaches for. */
  onProgress?: (event: AiProgressEvent) => void
}

export interface SupportAskResult {
  answer: string
  model: string
  /** Set when the assistant itself said a person should take over. */
  handoff: HandoffOffer | null
}

// A ceiling for thinking and the answer together (lib/agent/ask/ask-service.ts
// has the history of why it is this high), and for the tool loop: a page read,
// a search and a couple of ledger reads fit in six turns.
const MAX_TOKENS = 16_000
const MAX_STEPS = 6
const MAX_QUESTION_CHARS = 4000

/**
 * The readers of the skill library (the same Swedish accounting texts a
 * connected agent works from). A question about a rule is answered from the
 * skill that covers it, not from what the model happens to remember: the old
 * tool-loop chat had the same two for the same reason.
 */
export const SUPPORT_SKILL_TOOLS: readonly string[] = ['gnubok_list_skills', 'gnubok_load_skill']

/** The company's gated menu, loaded once for the prompt and for the page tools. Null when it cannot be resolved. */
async function loadUi(supabase: SupabaseClient, companyId: string, locale: Locale | undefined): Promise<UiMapInput | null> {
  try {
    const [ctx, labels] = await Promise.all([loadNavGateContext(supabase, companyId), loadUiLabels(locale)])
    if (!ctx) return null
    return { ctx, labels, hasMcpExtension: ENABLED_EXTENSION_IDS.has('mcp-server') }
  } catch (err) {
    log.warn('menu unavailable', { companyId, error: err instanceof Error ? err.message : String(err) })
    return null
  }
}

export async function answerSupportQuestion(req: SupportAskRequest): Promise<SupportAskResult> {
  const question = req.question.slice(0, MAX_QUESTION_CHARS).trim()
  const locale = req.locale ?? 'sv'
  const index = loadPageTextIndex()

  const [readTools, profile, snapshot, ui, messages] = await Promise.all([
    buildLedgerTools(req.supabase, req.companyId, req.userId, req.conversationId, [
      ...LEDGER_READ_TOOLS,
      ...SUPPORT_SKILL_TOOLS,
    ]),
    companyProfileLine(req.supabase, req.companyId),
    buildAssistantSnapshot(req.supabase, req.companyId),
    loadUi(req.supabase, req.companyId, locale),
    index ? loadMessageTree(locale) : Promise.resolve(null),
  ])

  let handoff: HandoffOffer | null = null
  const onHandoff = (offer: HandoffOffer) => {
    handoff = offer
  }
  // The page tools need the gated menu: without it they could not tell a page
  // this company has from one it does not.
  const hasPageTexts = Boolean(index && messages && ui)
  const appTools: AiToolDef[] =
    index && messages && ui
      ? buildAppTools({ index, messages, locale, ui, onHandoff })
      : [handoffTool(onHandoff)]
  // The assistant's own tools first, then the ledger's and the skill
  // readers: one order for every company, so the cached prefix (tools and
  // system prompt) is shared.
  const tools = [...appTools, ...readTools]
  const hasSkillTools = readTools.some((tool) => tool.name === 'gnubok_load_skill')
  const hasLedgerTools = readTools.some((tool) => !SUPPORT_SKILL_TOOLS.includes(tool.name))

  const promptParts: string[] = []
  if (profile) promptParts.push(profile)
  if (snapshot) {
    promptParts.push('Företagets nuläge (grunddata, inte hela bokföringen):')
    promptParts.push(snapshot)
    promptParts.push('')
  }
  if (ui) {
    promptParts.push(renderUiGrounding({ ...ui, route: req.route }))
    promptParts.push('')
  }
  promptParts.push(`Fråga: ${question}`)

  const effort = supportAssistantEffort()
  const result = await getAiService().generateText({
    tier: 'assistant',
    meter: { feature: 'support_ask', companyId: req.companyId },
    system: supportSystemPrompt({ locale, hasLedgerTools, hasPageTexts, hasSkillTools }),
    prompt: promptParts.join('\n'),
    ...(req.history && req.history.length > 0 ? { history: req.history } : {}),
    maxTokens: MAX_TOKENS,
    tools,
    maxSteps: MAX_STEPS,
    cachePrompt: true,
    ...(effort ? { effort } : {}),
    ...(req.onProgress ? { onProgress: req.onProgress } : {}),
  })

  const diagnostics = {
    companyId: req.companyId,
    model: result.model,
    usage: result.usage,
    toolCount: tools.length,
    hasPageTexts,
    stopReason: result.stopReason ?? null,
    truncated: result.truncated === true,
    forcedFinal: result.forcedFinal ?? null,
  }

  // No visible answer is a failure, never a result (ask-service.ts has the history).
  if (result.text.trim().length === 0) {
    log.error('model returned an empty answer', diagnostics)
    throw new EmptyModelAnswerError(result.model, { truncated: result.truncated === true })
  }
  if (result.forcedFinal) log.warn('answer needed the final answer turn', diagnostics)

  const answer = result.truncated ? `${result.text}\n\n${truncatedAnswerNote(locale)}` : result.text
  return { answer, model: result.model, handoff }
}
