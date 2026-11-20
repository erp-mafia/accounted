import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { loadAgentContext } from '@/lib/agent-context/wiki-load'

// GET /api/wiki/context
//
// The wiki's context view: what an agent receives when it opens the active
// company, from the briefing tool itself (lib/agent-context/wiki-load.ts),
// described part by part, plus the raw text the agent reads. Read-only;
// derived per request, never cached, so it cannot go stale.
export const GET = withRouteContext('wiki.context.get', async (_request, ctx) => {
  const { supabase, companyId, user } = ctx
  const result = await loadAgentContext(supabase, companyId, user.id)
  if (result.status === 'unavailable') {
    return NextResponse.json(
      {
        error: {
          code: 'AGENT_CONTEXT_UNAVAILABLE',
          message: 'Agentkopplingen finns inte i den här installationen.',
          message_en: 'The agent connection is not part of this installation.',
        },
      },
      { status: 404 },
    )
  }
  return NextResponse.json({ data: { window: result.window, text: result.text, scopes: result.scopes } })
})
