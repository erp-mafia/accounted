import { describe, it, expect } from 'vitest'
import { tools } from '../server'

describe('tools/list payload size guard', () => {
  it('keeps the projected tools/list payload under the context-budget ceiling', () => {
    const projection = tools.map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema,
      ...(t.outputSchema ? { outputSchema: t.outputSchema } : {}),
      annotations: t.annotations,
      ...(t._meta ? { _meta: t._meta } : {}),
    }))
    const payload = JSON.stringify({ tools: projection })
    const approxTokens = Math.round(payload.length / 4)
    // Ceiling progression: 20K → 25K → 30K.
    //   * 20K → 25K when item 8 of the agent-native API plan landed
    //     (additionalProperties: false on all inputSchemas + period_status in the
    //     staged operation envelope).
    //   * 25K → 30K when the agentic branch merged with main: catalog grew from
    //     ~75 to 83 tools (added gnubok_create_supplier, gnubok_list_pending_operations,
    //     gnubok_approve_pending_operation, gnubok_reject_pending_operation,
    //     gnubok_set_inbox_extracted_data from main + gnubok_get_agent_briefing,
    //     _remember_fact, _forget_fact, _feedback from the agent branch).
    // Long-term answer to growth is leaning harder on gnubok_search_tools — if this
    // fires again, prefer trimming descriptions or making a tool opt-in via search
    // before bumping further.
    expect(approxTokens).toBeLessThan(30_000)
  })
})
