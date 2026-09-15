import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { RollbackEntityTypeMigrationSchema } from '@/lib/api/schemas'
import { rollbackMigration } from '@/lib/company/entity-type-migration'
import { entityTypeMigrationErrorResponse } from '@/lib/company/entity-type-migration-route'

/**
 * POST /api/company/entity-type-migration/{id}/rollback { reversal_date? }
 *
 * Reverses the reclassification verifikat (storno through the engine) and
 * flips the legal form back through the owner-only RPC. Accounts added on
 * apply are kept.
 */
export const POST = withRouteContext<{ params: Promise<{ id: string }> }>(
  'company.entity_type_migration_rollback',
  async (request, ctx, { params }) => {
    const { id } = await params
    const { supabase, companyId, user, log, requestId } = ctx
    const validation = await validateBody(request, RollbackEntityTypeMigrationSchema, {
      log,
      operation: 'company.entity_type_migration_rollback',
    })
    if (!validation.success) return validation.response
    try {
      const data = await rollbackMigration(supabase, companyId, user.id, id, validation.data.reversal_date)
      return NextResponse.json({ data })
    } catch (err) {
      return entityTypeMigrationErrorResponse(err, log, requestId)
    }
  },
  { requireWrite: true },
)
