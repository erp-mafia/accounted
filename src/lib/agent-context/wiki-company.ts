import { isArkivBrainEnabled } from '@/lib/arkiv/flag'
import { isAgentPictureEnabled } from '@/lib/env/agent-picture-switch'
import { ENABLED_EXTENSION_IDS } from '@/lib/extensions/_generated/enabled-extensions'
import type { WikiCompany } from './wiki-views'

/** The extension that is the agent connection: the MCP server. */
const AGENT_CONNECTION_EXTENSION = 'mcp-server'

/**
 * What decides where an address of the wiki ends for a company: whether it
 * has the agent picture (lib/env/agent-picture-switch.ts), whether Arkiv
 * reads its documents (lib/arkiv/flag.ts), and whether the installation has
 * the agent connection. Read once here for /wiki and for every page that
 * forwards into it, so they ask wikiPlace about the same company.
 *
 * `extensions` is what the installation is built with; a test names it.
 *
 * Server only: the switches are read from the environment.
 */
export function wikiCompany(companyId: string | null | undefined, extensions: ReadonlySet<string> = ENABLED_EXTENSION_IDS): WikiCompany {
  return {
    picture: isAgentPictureEnabled(companyId),
    facts: !!companyId && isArkivBrainEnabled(companyId),
    agentConnection: extensions.has(AGENT_CONNECTION_EXTENSION),
  }
}
