import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'

/**
 * GET /api/import/sie/[id]
 * Get details of a specific SIE import
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'sie_import.get',
  async (_request, { supabase, companyId }, { params }) => {
    const { id } = await params

    const { data, error } = await supabase
      .from('sie_imports')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    if (!data) {
      return NextResponse.json({ error: 'Import not found' }, { status: 404 })
    }

    return NextResponse.json({ data })
  },
)

/**
 * DELETE /api/import/sie/[id]
 * Delete an import record.
 *
 * Only failed or pending imports can be deleted. Completed imports have created
 * journal entries that are part of räkenskapsinformation: deleting the metadata
 * without reversing entries would leave orphaned bookkeeping data, and deleting
 * both is prohibited under BFL 7 kap (7-year retention).
 */
export const DELETE = withRouteContext<{ params: Promise<{ id: string }> }>(
  'sie_import.delete',
  async (_request, { supabase, companyId }, { params }) => {
    const { id } = await params

    // Check current status before deleting
    const { data: importRecord } = await supabase
      .from('sie_imports')
      .select('status')
      .eq('id', id)
      .eq('company_id', companyId)
      .single()

    if (!importRecord) {
      return NextResponse.json({ error: 'Import not found' }, { status: 404 })
    }

    if (importRecord.status === 'completed') {
      return NextResponse.json({
        error: 'Slutförd import kan inte raderas. Importerade verifikationer ingår i räkenskapsinformationen (BFL 7 kap).',
      }, { status: 403 })
    }

    const { error } = await supabase
      .from('sie_imports')
      .delete()
      .eq('id', id)
      .eq('company_id', companyId)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ success: true })
  },
  { requireWrite: true },
)
