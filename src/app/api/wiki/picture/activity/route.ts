import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { loadAgentActivity } from '@/lib/agent-context/agent-picture'
import { isAgentPictureEnabled } from '@/lib/env/agent-picture-switch'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

// GET /api/wiki/picture/activity
//
// Only what the company's connections did: per connection, the tool calls
// made today and the time of the last one, with the server's clock
// (lib/agent-context/agent-picture.ts loadAgentActivity). One read of the
// tool call log, for the picture to ask again while it is open. The log
// holds which tool was called and by whom, never what was read.
//
// 404 for a company outside AGENT_PICTURE_COMPANY_IDS.
export const GET = withRouteContext('wiki.picture.activity', async (_request, ctx) => {
  const { supabase, companyId, log, requestId } = ctx
  if (!isAgentPictureEnabled(companyId)) return errorResponseFromCode('NOT_FOUND', log, { requestId })
  return NextResponse.json({ data: await loadAgentActivity(supabase, companyId) })
})
