import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { PlanEntityTypeMigrationSchema } from '@/lib/api/schemas'
import { listMigrations, planMigration } from '@/lib/company/entity-type-migration'
import { entityTypeMigrationErrorResponse } from '@/lib/company/entity-type-migration-route'

/**
 * GET  /api/company/entity-type-migration
 * POST /api/company/entity-type-migration { entity_type }
 *
 * Legal-form migration of the active company when its books are not empty
 * (design section 11). GET lists the company's planned, applied and
 * rolled-back migrations. POST snapshots the preview and stores a planned
 * migration with one remap proposal per decision account, every proposal
 * skipped until the owner confirms it on apply. Owner-only: the preview RPC
 * reports the caller's role and planMigration refuses anyone else. A company
 * whose books are empty is sent to PATCH /api/company/current instead.
 */
export const GET = withRouteContext('company.entity_type_migration_list', async (_request, ctx) => {
  const { supabase, companyId, log, requestId } = ctx
  try {
    const data = await listMigrations(supabase, companyId)
    return NextResponse.json({ data })
  } catch (err) {
    return entityTypeMigrationErrorResponse(err, log, requestId)
  }
})

export const POST = withRouteContext(
  'company.entity_type_migration_plan',
  async (request, ctx) => {
    const { supabase, companyId, user, log, requestId } = ctx
    const validation = await validateBody(request, PlanEntityTypeMigrationSchema, {
      log,
      operation: 'company.entity_type_migration_plan',
    })
    if (!validation.success) return validation.response
    try {
      const data = await planMigration(supabase, companyId, user.id, validation.data.entity_type)
      return NextResponse.json({ data }, { status: 201 })
    } catch (err) {
      return entityTypeMigrationErrorResponse(err, log, requestId)
    }
  },
  { requireWrite: true },
)
