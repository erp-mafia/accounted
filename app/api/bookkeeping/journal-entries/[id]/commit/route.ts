import { NextResponse } from 'next/server'
import { commitEntry } from '@/lib/bookkeeping/engine'
import { evaluateCommitGates } from '@/lib/bookkeeping/commit-gates'
import { ensureInitialized } from '@/lib/init'
import { withRouteContext } from '@/lib/api/with-route-context'

ensureInitialized()

export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'bookkeeping.journal-entry.commit',
  async (_request, { supabase, companyId, user }, { params }) => {
    const { id } = await params

    const gates = await evaluateCommitGates(supabase, companyId, id)
    if (!gates.ok) {
      return NextResponse.json(
        {
          error: {
            code: 'COMMIT_GATE_FAILED',
            message: gates.blocked.map((b) => b.message).join('; '),
            blocked: gates.blocked,
            warnings: gates.warnings,
          },
        },
        { status: 400 },
      )
    }

    const posted = await commitEntry(supabase, companyId, user.id, id, 'user_accept')
    return NextResponse.json({
      data: posted,
      warnings: gates.warnings.length > 0 ? gates.warnings : undefined,
    })
  },
  { requireWrite: true },
)
