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
 * it off. The founders decided 2026-11-17 to remove the chat in favour of the
 * assistant a customer connects over MCP (Agenter > Koppla en agent,
 * /settings/api): the switch is how the chat goes on the day they pick, and
 * the line in the chat (components/agent/ChatRemovalNotice.tsx) tells people
 * first.
 *
 * Off: no door is offered, the /chat pages and the build page send their
 * visitor to /settings/api and the two routes answer ASSISTANT_CHAT_OFF
 * instead of running a turn, for every intent. The interview a newly built
 * assistant held with the company (intent onboarding.intake) goes with the
 * rest (founder decision 2026-11-18): no intent is exempt. Nothing is
 * deleted: conversations stay in the database.
 *
 * What the switch never stops: the MCP server, agent profiles and memory,
 * pending operations (a proposal the chat staged is still approved or
 * rejected under Att göra > Rutin, /pending) and categorisation.
 *
 * Server only: the variable is not public, so a browser bundle always reads
 * it as on. Client components read the layout's answer instead
 * (useAssistantChatEnabled in contexts/CompanyContext.tsx).
 */
type Env = Record<string, string | undefined>

const OFF_VALUES = new Set(['false', '0', 'off', 'no'])

/** Whether the built-in assistant is switched on in this installation. */
export function assistantChatEnabled(env: Env = process.env): boolean {
  const value = env.ASSISTANT_CHAT_ENABLED?.trim().toLowerCase()
  return value === undefined || !OFF_VALUES.has(value)
}
