import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { AccountKeySchema } from '@/lib/reconciliation/schemas'
import { matchPairs } from '@/lib/reconciliation/actions'

const PairSchema = z.object({
  external_ids: z.array(z.string().uuid()).min(1).max(50),
  journal_entry_ids: z.array(z.string().uuid()).min(1).max(50),
  // Bank 1:N only: the signed slice per verifikat (transaction sign
  // convention). Omitted: each slice defaults to the voucher's bank line.
  allocations: z
    .array(z.object({ journal_entry_id: z.string().uuid(), amount: z.number() }))
    .min(2)
    .max(50)
    .optional(),
})

const ReconciliationLinksBodySchema = z
  .object({
    pairs: z.array(PairSchema).max(200).optional(),
    use_proposals: z.boolean().optional(),
    confidence_threshold: z.number().min(0).max(1).optional(),
    dry_run: z.boolean().optional(),
  })
  .refine((b) => (b.pairs && b.pairs.length > 0) || b.use_proposals === true, {
    message: 'Ange pairs eller use_proposals: true.',
  })

/**
 * POST /api/reconciliation/accounts/{accountKey}/links
 *
 * The page's "Koppla" and "Koppla N föreslagna": link outside rows to existing
 * verifikat (N:1), or one bank transaction to several verifikat (1:N, with
 * optional allocations). A human clicked, so this applies directly (dry_run:
 * true for the preview). Same service function as v1 and the MCP commit
 * executor.
 */
export const POST = withRouteContext<{ params: Promise<{ accountKey: string }> }>(
  'reconciliation.accounts.links.create',
  async (request, { supabase, user, companyId }, { params }) => {
    const { accountKey } = await params
    if (!AccountKeySchema.safeParse(accountKey).success) {
      return NextResponse.json({ error: 'Okänt konto' }, { status: 404 })
    }
    const validation = await validateBody(request, ReconciliationLinksBodySchema)
    if (!validation.success) return validation.response
    const { dry_run, ...input } = validation.data

    const result = await matchPairs(supabase, companyId, user.id, accountKey, input, {
      dryRun: dry_run === true,
    })
    if (!result) {
      return NextResponse.json({ error: 'Okänt konto för det här företaget' }, { status: 404 })
    }
    return NextResponse.json({ data: result })
  },
  { requireWrite: true },
)
