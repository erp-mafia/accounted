import type { McpResource } from './types'
import { isArkivEnabled } from '@/lib/arkiv/flag'
import { getCompanyGraph } from '@/lib/arkiv/graph/snapshot'

/**
 * Arkiv phase 9b. The company graph, aggregated: clusters with counts, every
 * node with its record reference, every link with the evidence behind it.
 * Orient here, then pull one thing's neighbourhood with
 * gnubok_get_neighbourhood, and read a record with gnubok_get_record.
 */
export const arkivGraphResource: McpResource = {
  uri: 'Accounted://arkiv/graph',
  name: 'Arkiv Company Graph',
  description:
    'The whole company as one graph: accounts with movement, counterparties, agreements, documents, registered facts, people, authorities and what is coming, as nodes with record references and links with evidence (a foreign key, a matched payment, or an aggregate). Aggregated so it stays small; gnubok_get_neighbourhood expands one node.',
  mimeType: 'application/json',
  read: async ({ supabase, companyId }) => {
    if (!isArkivEnabled(companyId)) return { enabled: false, reason: 'Arkiv is not switched on for this company.' }
    const graph = await getCompanyGraph(supabase, companyId)
    return {
      ...graph,
      how_to: [
        'Every node ref is a record reference: gnubok_get_record reads it, gnubok_get_source opens a document page, gnubok_ask_document asks the text.',
        'gnubok_get_neighbourhood with a ref and a depth returns the subgraph around one thing, as JSON and as a plain adjacency list.',
        'A node with meta.missing is something the books expect but the archive lacks; Accounted://arkiv/missing says how to resolve it.',
        'series holds twelve months of movement per account, so "this month" and "the year so far" are the same snapshot.',
      ],
    }
  },
}
