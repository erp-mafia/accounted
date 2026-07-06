import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'

/**
 * GET /api/import/sie/[id]
 * Get details of a specific SIE import
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient()
  const { id } = await params

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const companyId = await requireCompanyId(supabase, user.id)

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
}

/**
 * DELETE /api/import/sie/[id]
 * Delete an import record.
 *
 * Only failed or pending imports can be deleted. Completed imports have created
 * journal entries that are part of räkenskapsinformation: deleting the metadata
 * without reversing entries would leave orphaned bookkeeping data, and deleting
 * both is prohibited under BFL 7 kap (7-year retention).
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const supabase = await createClient()
  const { id } = await params

  const {
    data: { user },
  } = await supabase.auth.getUser()

  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)

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
}
