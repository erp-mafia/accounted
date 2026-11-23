import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { loadAgentPicture } from '@/lib/agent-context/agent-picture'
import { isAgentPictureEnabled } from '@/lib/env/agent-picture-switch'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { withSIEExternalReport } from '@/lib/import/sie-period-read'
import { countOpenQuestions } from '@/lib/questions/app-answer'
import { readSkatteverketConnection } from '@/lib/skatteverket/connection-state'
import { readReportedSkattekontoSaldo } from '@/lib/skatteverket/skattekonto-ocr'
import { countPendingOperations } from '@/lib/worklist/categories'

// GET /api/wiki/picture
//
// The picture of what a connected agent gets, for the active company and the
// signed-in person: what is connected, the company (counts, memory,
// knowledge, checks) and the agents with what they did today
// (lib/agent-context/agent-picture.ts). Read-only and derived per request.
// Each part is best effort: a part that could not be read is unknown in the
// answer, so the route answers 200 with whatever could be read.
//
// 404 for a company outside AGENT_PICTURE_COMPANY_IDS.
//
// The route wires in the readers that belong to other modules: the
// checks run behind the SIE import lease, like every other door to the
// unexplained queue, and the Skatteverket connection is read by its own
// rule, with the time of the last fetched skattekonto saldo while connected.
// What waits on the company's people is counted by the counters Hem and the
// menu read (the open questions, none for a company without the question
// list, and the proposals that wait for approval), so the picture says the
// same numbers.
export const GET = withRouteContext('wiki.picture.get', async (_request, ctx) => {
  const { supabase, companyId, user, log, requestId } = ctx
  if (!isAgentPictureEnabled(companyId)) return errorResponseFromCode('NOT_FOUND', log, { requestId })

  const picture = await loadAgentPicture(supabase, companyId, user.id, {
    ledgerRead: (read) => withSIEExternalReport(supabase, companyId, 'unexplained.list', read),
    skatteverket: async () => {
      const [state, saldo] = await Promise.all([
        readSkatteverketConnection(supabase, companyId),
        readReportedSkattekontoSaldo(supabase, companyId),
      ])
      // The saldo snapshot outlives a disconnect: its time counts only while connected.
      return { state, last_sync_at: state === 'connected' ? (saldo?.fetched_at ?? null) : null }
    },
    waiting: async () => {
      const [questions, proposals] = await Promise.all([countOpenQuestions(supabase, companyId), countPendingOperations(supabase, companyId)])
      return { questions, proposals }
    },
  })
  return NextResponse.json({ data: picture })
})
