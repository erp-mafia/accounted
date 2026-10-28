/**
 * Who did something, in words: the agent and the person it acted for
 * ("Claude åt Jonas Ek"), never the credential it came through ("API-nyckel:
 * MCP-klient (OAuth)", "AI-assistent · MCP-klient (OAuth)").
 *
 * Formatting only. Every input is already stored on the row: actor_type and
 * actor_label on journal_entries (committed_actor_*), pending_operations and
 * audit_log, and the user id the caller resolves to a name (the key's owner,
 * a service account's sponsor, the person who chatted). History therefore
 * reads the new way retroactively.
 *
 * Pure and client-safe. The words come from the caller: UI code builds them
 * from the `attribution` messages (attributionWordsFrom), the Swedish-only
 * legal surfaces (behandlingshistoriken) use SV_ATTRIBUTION_WORDS. Words are
 * given in their sentence-medial form ("assistenten"); a standalone phrase
 * gets its first letter raised, an inline one (inside "Bokförd av {who}")
 * keeps it.
 */

/**
 * The reserved name of every key the MCP OAuth token route mints
 * (OAUTH_MCP_KEY_NAME in lib/auth/api-keys.ts, server-only, so repeated here
 * and pinned by the test). It names no client: the connection whose client
 * is unknown reads as a neutral "AI-anslutning".
 */
export const RESERVED_OAUTH_KEY_NAME = 'MCP-klient (OAuth)'

/**
 * Suffixes the MCP server appends to a connector's label (oauthActorLabel in
 * lib/agent-skills/provenance.ts, and "<client_name> (registered client)"):
 * the provider is noise beside the agent's own name. Pinned by the test
 * against oauthActorLabel's outputs. A manual key's own parentheses are kept.
 */
const CONNECTOR_SUFFIX = /\s+\((?:Anthropic|OpenAI|xAI|registered client)\)$/

export interface AttributionWords {
  /** "{agent} åt {person}". */
  actedFor: (agent: string, person: string) => string
  /** An AI connection whose client is not known (the reserved OAuth key name). */
  aiConnection: string
  /** The in-app assistant (agent_chat). */
  assistant: string
  /** A scheduled job (cron). */
  scheduledRun: string
  /** Something the app did by itself (system). */
  system: string
  /** "tjänstekontot {name}". */
  serviceAccount: (name: string) => string
  /** A service account without a recorded name. */
  serviceAccountPlain: string
  /** An API key without a recorded name. */
  apiKeyPlain: string
  /** A person whose name could not be resolved. */
  unknownPerson: string
}

export const SV_ATTRIBUTION_WORDS: AttributionWords = {
  actedFor: (agent, person) => `${agent} åt ${person}`,
  aiConnection: 'AI-anslutning',
  assistant: 'assistenten',
  scheduledRun: 'schemalagd körning',
  system: 'systemet',
  serviceAccount: (name) => `tjänstekontot ${name}`,
  serviceAccountPlain: 'ett tjänstekonto',
  apiKeyPlain: 'en API-nyckel',
  unknownPerson: 'en användare',
}

/** The words from the `attribution` message namespace (UI code). */
export function attributionWordsFrom(t: (key: string, values?: Record<string, string>) => string): AttributionWords {
  return {
    actedFor: (agent, person) => t('acted_for', { agent, person }),
    aiConnection: t('ai_connection'),
    assistant: t('assistant'),
    scheduledRun: t('scheduled_run'),
    system: t('system'),
    serviceAccount: (name) => t('service_account', { name }),
    serviceAccountPlain: t('service_account_plain'),
    apiKeyPlain: t('api_key_plain'),
    unknownPerson: t('person_unknown'),
  }
}

export interface ActorAttributionInput {
  /** user | api_key | mcp_oauth | cron | system | agent_chat | service_account; anything else reads as a person. */
  actorType: string | null | undefined
  /** The stored label: a key's or service account's name, a connector's provider label, a person's snapshot. */
  actorLabel?: string | null
  /** The person the agent acted for (the key owner, the sponsor, who chatted), resolved by the caller. */
  personName?: string | null
}

export interface AttributionOptions {
  /** Inside a sentence ("Bokförd av {who}"): a generic word keeps its lower-case first letter. */
  inline?: boolean
}

function text(value: string | null | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

function upperFirst(value: string): string {
  return value ? value.charAt(0).toLocaleUpperCase() + value.slice(1) : value
}

/** The agent's name or the generic word for it, and whether it is a generic word. */
function agentName(actorType: string | null | undefined, actorLabel: string | null | undefined, words: AttributionWords): { name: string; generic: boolean } {
  const label = text(actorLabel)
  switch (actorType) {
    case 'api_key':
    case 'mcp_oauth': {
      if (!label) return actorType === 'mcp_oauth' ? { name: words.aiConnection, generic: true } : { name: words.apiKeyPlain, generic: true }
      if (label === RESERVED_OAUTH_KEY_NAME) return { name: words.aiConnection, generic: true }
      return { name: label.replace(CONNECTOR_SUFFIX, '') || label, generic: false }
    }
    case 'service_account':
      return label ? { name: label, generic: false } : { name: words.serviceAccountPlain, generic: true }
    case 'agent_chat':
      return { name: words.assistant, generic: true }
    case 'cron':
      return { name: words.scheduledRun, generic: true }
    case 'system':
      return { name: words.system, generic: true }
    default:
      return label ? { name: label, generic: false } : { name: words.unknownPerson, generic: true }
  }
}

/**
 * The agent's own name, without the credential wording: "Claude (Anthropic)"
 * is Claude, "<name> (registered client)" its name, the reserved OAuth key
 * an AI-anslutning, a manual key or a service account its name, agent_chat
 * the assistant, cron a scheduled run, system the system, a person the
 * person's label.
 */
export function agentDisplayName(
  actorType: string | null | undefined,
  actorLabel: string | null | undefined,
  words: AttributionWords = SV_ATTRIBUTION_WORDS,
  options: AttributionOptions = {},
): string {
  const { name, generic } = agentName(actorType, actorLabel, words)
  return generic && !options.inline ? upperFirst(name) : name
}

/**
 * The display string for who did something: "Claude åt Jonas Ek",
 * "Lagerskript åt Jonas Ek", "Tjänstekontot Lager åt Jonas Ek",
 * "Assistenten åt Jonas Ek"; just the agent when the person is unknown.
 * A scheduled run and the system act for no one. A person is the person.
 */
export function formatActorAttribution(
  input: ActorAttributionInput,
  words: AttributionWords = SV_ATTRIBUTION_WORDS,
  options: AttributionOptions = {},
): string {
  const person = text(input.personName)
  const finish = (value: string, generic: boolean) => (generic && !options.inline ? upperFirst(value) : value)
  switch (input.actorType) {
    case 'cron':
    case 'system': {
      const { name } = agentName(input.actorType, null, words)
      return finish(name, true)
    }
    case 'api_key':
    case 'mcp_oauth':
    case 'agent_chat':
    case 'service_account': {
      const label = text(input.actorLabel)
      const agent =
        input.actorType === 'service_account' && label
          ? { name: words.serviceAccount(label), generic: true }
          : agentName(input.actorType, label, words)
      return finish(person ? words.actedFor(agent.name, person) : agent.name, agent.generic)
    }
    default: {
      if (person) return person
      const { name, generic } = agentName('user', input.actorLabel, words)
      return finish(name, generic)
    }
  }
}
