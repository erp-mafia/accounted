import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { AGENT_CARD_ID_RE } from '@/lib/agent-context/agent-cards'
import { loadAgentCardWork } from '@/lib/agent-context/agent-work'
import { isAgentPictureEnabled } from '@/lib/env/agent-picture-switch'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

// `card`: the id of one card of the picture's agents column, as GET
// /api/wiki/picture hands it out (a kind, or `key:` or `account:` and an id).
const querySchema = z.object({ card: z.string().regex(AGENT_CARD_ID_RE) })

// GET /api/wiki/picture/agent?card=<id>
//
// What one card of the agent picture did for the active company, for the
// signed-in person (lib/agent-context/agent-work.ts): the questions its
// connections asked that wait for an answer, with how many were answered,
// and the proposals they prepared that wait for approval, each with what its
// line is built from, with how many were approved and rejected in the last
// 30 days. `questions` is null for a company without the question list.
// Read-only, through the caller's own client with the company filter: a
// reader gets the questions and the proposals their own access gives them.
//
// 404 for a company outside AGENT_PICTURE_COMPANY_IDS, and for a card the
// person cannot list. 400 for a `card` that is not a card id.
export const GET = withRouteContext('wiki.picture.agent', async (request, ctx) => {
  const { supabase, companyId, user, log, requestId } = ctx
  if (!isAgentPictureEnabled(companyId)) return errorResponseFromCode('NOT_FOUND', log, { requestId })

  const query = validateQuery(request, querySchema)
  if (!query.success) return query.response

  const work = await loadAgentCardWork(supabase, companyId, user.id, query.data.card)
  if (!work) return errorResponseFromCode('NOT_FOUND', log, { requestId })
  return NextResponse.json({ data: work })
})
