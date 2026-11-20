/**
 * ASSISTANT_CHAT_ENABLED: the built-in assistant. Its doors are the floating
 * button, the Chatt row in the menu, the /chat pages, the panel a page opens
 * (AgentSheet), the build of the assistant (/onboarding/agent, offered on
 * Hem) with the interview that follows it (/chat/intake), and the turns
 * behind POST /api/agent/invoke and POST /api/agent/ask.
 *
 * On until someone switches it off. Unset, empty or any other value keeps the
 * chat, so a self-hosted installation and hosted production lose nothing by
 * upgrading; `false`, `0`, `off` or `no` (any case, spaces trimmed) switches
 * it off. The chat is to be removed in favour of the assistant a customer
 * connects over MCP (Agenter > Koppla en agent, /settings/api): the switch is
 * how the chat goes, and
 * the line in the chat (components/agent/ChatRemovalNotice.tsx) tells people
 * first.
 *
 * Off: no door is offered, /chat shows what took the chat's place
 * (components/agent/ChatReplaced.tsx), its other pages and the build page
 * lead there, and the two routes answer ASSISTANT_CHAT_OFF instead of running
 * a turn, for every intent. The interview a newly built assistant held with
 * the company (intent onboarding.intake) goes with the rest: no intent is
 * exempt. Nothing is deleted: conversations stay in the database.
 *
 * Off is per company (assistantChatEnabledFor): the companies listed in
 * ASSISTANT_CHAT_COMPANY_IDS keep the chat until ASSISTANT_CHAT_UNTIL, so a
 * company that works in it is not cut off the day everyone else's goes.
 *
 * What the switch never stops: the MCP server, agent profiles and memory,
 * pending operations (a proposal the chat staged is still approved or
 * rejected under Att göra > Rutin, /pending) and categorisation.
 *
 * Server only: the variable is not public, so a browser bundle always reads
 * it as on. Client components read the layout's answer instead
 * (useAssistantChatEnabled in contexts/CompanyContext.tsx).
 */
import { isSaneDateString } from '@/lib/invariants/iso-date'

type Env = Record<string, string | undefined>

const OFF_VALUES = new Set(['false', '0', 'off', 'no'])

/** Whether the built-in assistant is switched on in this installation. */
export function assistantChatEnabled(env: Env = process.env): boolean {
  const value = env.ASSISTANT_CHAT_ENABLED?.trim().toLowerCase()
  return value === undefined || !OFF_VALUES.has(value)
}

/**
 * ASSISTANT_CHAT_UNTIL: the last day the companies that keep the chat have
 * it, as YYYY-MM-DD. Null when unset or not a date: they keep it until the
 * list is emptied. The chat's own notice and the page that replaces the chat
 * name the day.
 */
export function assistantChatUntil(env: Env = process.env): string | null {
  const value = env.ASSISTANT_CHAT_UNTIL?.trim() ?? ''
  return isSaneDateString(value) ? value : null
}

/** ASSISTANT_CHAT_COMPANY_IDS: the companies that keep the chat while it is switched off (ids, lowercased, each once). */
function keptCompanies(env: Env): ReadonlySet<string> {
  const raw = env.ASSISTANT_CHAT_COMPANY_IDS ?? ''
  return new Set(raw.toLowerCase().split(',').map((id) => id.trim()).filter(Boolean))
}

/**
 * Whether the built-in assistant is gone for every company: switched off
 * with nobody on the list of companies that keep it, or past the last day.
 * A route that would run a turn asks this first, before it reads who is
 * asking: the answer needs no company.
 */
export function assistantChatOffForEveryone(today: string, env: Env = process.env): boolean {
  if (assistantChatEnabled(env)) return false
  const until = assistantChatUntil(env)
  if (until !== null && today > until) return true
  return keptCompanies(env).size === 0
}

/**
 * Whether the Chatt row is in the menu. For as long as some company has the
 * chat, every company keeps the row: it leads to the chat where the company
 * has it, and elsewhere to the page that says what took its place. Once the
 * chat is gone for everyone, the row goes too.
 */
export function assistantChatRowShown(today: string, env: Env = process.env): boolean {
  return !assistantChatOffForEveryone(today, env)
}

/**
 * Whether this company has the built-in assistant.
 *
 * Switched on, every company has it. Switched off, it is gone for every
 * company except the ones in ASSISTANT_CHAT_COMPANY_IDS: the companies that
 * were using it when it was switched off, and any company that asks to have
 * it back. They keep it through ASSISTANT_CHAT_UNTIL; from the day after, it
 * is gone for them too. Nobody else can start: without the chat there is no
 * door to its build or its interview.
 *
 * `today` is the Swedish calendar day (todayIsoStockholm), passed in so this
 * file reads nothing but the environment.
 */
export function assistantChatEnabledFor(
  companyId: string | null | undefined,
  today: string,
  env: Env = process.env,
): boolean {
  if (assistantChatEnabled(env)) return true
  if (!companyId) return false
  const until = assistantChatUntil(env)
  if (until !== null && today > until) return false
  return keptCompanies(env).has(companyId.toLowerCase())
}
