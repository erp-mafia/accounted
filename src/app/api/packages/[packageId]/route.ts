/**
 * POST /api/packages/:packageId: the Anpassa page's switch for one package.
 *
 * { enabled, dry_run: true } answers the dry run of packages.enable or
 * packages.disable (lib/operations/packages.ts): for switching off, what is
 * still open and will keep the package winding down; for switching on, a
 * refusal when the plan, the country or the legal form does not offer it.
 * Without dry_run it stages enable_package or disable_package as the
 * signed-in user and answers the pending operation; the page then approves
 * it through POST /api/pending-operations/:id/commit, the door every staged
 * operation has, where set_company_package_choice re-checks that the
 * approver is an owner or admin. A member's proposal waits there for one.
 *
 * Staged through the service client: pending_operations has no insert
 * policy for a person's own session (only the in-app chat's), exactly as the
 * MCP and v1 doors stage.
 */
import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { PackageSwitchBodySchema } from '@/lib/api/schemas'
import { packagesDisable, packagesEnable } from '@/lib/operations/packages'
import { sessionFailureResponse } from '@/lib/operations/session'
import { stageOperation } from '@/lib/operations/stage'
import { SWITCHABLE_PACKAGE_IDS } from '@/lib/suggestions/package-switch'
import { createServiceClient } from '@/lib/supabase/server'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

export const POST = withRouteContext<{ params: Promise<{ packageId: string }> }>(
  'packages.switch',
  async (request, { user, companyId, log, requestId }, { params }) => {
    const { packageId } = await params
    if (!SWITCHABLE_PACKAGE_IDS.includes(packageId)) {
      return errorResponseFromCode('PACKAGE_NOT_SWITCHABLE', log, { requestId })
    }
    const validation = await validateBody(request, PackageSwitchBodySchema)
    if (!validation.success) return validation.response
    const { enabled, dry_run: dryRun } = validation.data

    const op = enabled ? packagesEnable : packagesDisable
    const ctx = { supabase: createServiceClient(), companyId, userId: user.id, log }
    const input = { package_id: packageId }

    if (dryRun) {
      const preview = await op.run(ctx, input, { dryRun: true })
      if (!preview.ok) return sessionFailureResponse(preview, log, requestId)
      return NextResponse.json({ data: preview.dryRun ? preview.preview : {} })
    }

    const staged = await stageOperation(op, ctx, input, { type: 'user', label: user.email ?? null }, { dryRun: false })
    if (!staged.ok) return sessionFailureResponse(staged.outcome, log, requestId)
    if (staged.dryRun) return NextResponse.json({ data: { preview: staged.plan.preview } })
    return NextResponse.json({
      data: {
        pending_operation_id: staged.row.id,
        operation_type: staged.plan.pendingType,
        title: staged.plan.title,
        preview: staged.plan.preview,
      },
    })
  },
  { requireWrite: true },
)
