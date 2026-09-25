import type { McpResource } from './types'
import { isArkivBrainEnabled, isArkivEnabled } from '@/lib/arkiv/flag'
import { buildArkivMap } from '@/lib/arkiv/map'

/**
 * The orientation map of the company archive (phase 8): read this first,
 * then search. A few kilobytes: what the archive holds, the company's
 * registered facts, running agreements with their next dates, what waits
 * for a person, and which tool does what. Never the data itself.
 */
export const arkivMapResource: McpResource = {
  uri: 'Accounted://arkiv/map',
  name: 'Arkiv Map',
  description:
    'Orientation before searching the archive: document counts by group, the latest documents and which tool gathers, finds and reads them. Where the company brain is on, also running agreements, registered facts and what waits. Refs, not data.',
  mimeType: 'application/json',
  read: async ({ supabase, companyId }) => {
    if (!isArkivEnabled(companyId)) return { enabled: false, reason: 'Arkiv is not switched on for this company.' }
    return buildArkivMap(supabase, companyId, { brain: isArkivBrainEnabled(companyId) })
  },
}
