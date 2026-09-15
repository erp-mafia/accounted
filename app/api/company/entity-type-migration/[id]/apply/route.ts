import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { ApplyEntityTypeMigrationSchema } from '@/lib/api/schemas'
import { applyMigration } from '@/lib/company/entity-type-migration'
import { entityTypeMigrationErrorResponse } from '@/lib/company/entity-type-migration-route'

/**
 * POST /api/company/entity-type-migration/{id}/apply { remap_plan, entry_date? }
 *
 * Applies a planned migration: every decision account with a balance must be
 * confirmed with a target account or skipped explicitly; the RPC refuses a
 * stale plan (balances moved since planning) and anyone but the owner; the
 * confirmed remaps are then booked as one reclassification verifikat through
 * the bookkeeping engine and linked on the migration.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'company.entity_type_migration_apply',
  async (request, ctx, { params }) => {
    const { id } = await params
    const { supabase, companyId, user, log, requestId } = ctx
    const validation = await validateBody(request, ApplyEntityTypeMigrationSchema, {
      log,
      operation: 'company.entity_type_migration_apply',
    })
    if (!validation.success) return validation.response
    try {
      const data = await applyMigration(
        supabase,
        companyId,
        user.id,
        id,
        validation.data.remap_plan,
        validation.data.entry_date,
      )
      return NextResponse.json({ data })
    } catch (err) {
      return entityTypeMigrationErrorResponse(err, log, requestId)
    }
  },
  { requireWrite: true },
)
