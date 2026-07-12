import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { saveMappings } from '@/lib/import/sie-import'
import type { AccountMapping } from '@/lib/import/types'

/**
 * GET /api/import/sie/mappings
 * Get all saved account mappings for the user
 */
export const GET = withRouteContext(
  'sie_import.mappings.list',
  async (_request, { supabase, companyId }) => {
    const { data, error } = await supabase
      .from('sie_account_mappings')
      .select('*')
      .eq('company_id', companyId)
      .order('source_account')

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ data })
  },
)

/**
 * POST /api/import/sie/mappings
 * Save account mappings (bulk upsert)
 */
export const POST = withRouteContext(
  'sie_import.mappings.save',
  async (request, { supabase, user }) => {
    const body = await request.json()
    const mappings: AccountMapping[] = body.mappings

    if (!mappings || !Array.isArray(mappings)) {
      return NextResponse.json({ error: 'Invalid mappings data' }, { status: 400 })
    }

    try {
      await saveMappings(supabase, user.id, mappings)
      return NextResponse.json({ success: true })
    } catch (error) {
      return NextResponse.json(
        { error: error instanceof Error ? error.message : 'Failed to save mappings' },
        { status: 500 }
      )
    }
  },
  { requireWrite: true },
)

/**
 * PUT /api/import/sie/mappings
 * Update a single mapping
 */
export const PUT = withRouteContext(
  'sie_import.mappings.update',
  async (request, { supabase, user, companyId }) => {
    const body = await request.json()
    const { sourceAccount, targetAccount } = body

    if (!sourceAccount || !targetAccount) {
      return NextResponse.json(
        { error: 'sourceAccount and targetAccount are required' },
        { status: 400 }
      )
    }

    const { data, error } = await supabase
      .from('sie_account_mappings')
      .upsert({
        user_id: user.id,
        company_id: companyId,
        source_account: sourceAccount,
        target_account: targetAccount,
        confidence: 1.0,
        match_type: 'manual',
      }, {
        onConflict: 'user_id,source_account',
      })
      .select()
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ data })
  },
  { requireWrite: true },
)

/**
 * DELETE /api/import/sie/mappings
 * Delete a specific mapping or all mappings
 */
export const DELETE = withRouteContext(
  'sie_import.mappings.delete',
  async (request, { supabase, companyId }) => {
    const { searchParams } = new URL(request.url)
    const sourceAccount = searchParams.get('sourceAccount')

    if (sourceAccount) {
      // Delete specific mapping
      const { error } = await supabase
        .from('sie_account_mappings')
        .delete()
        .eq('company_id', companyId)
        .eq('source_account', sourceAccount)

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 })
      }
    } else {
      // Delete all mappings
      const { error } = await supabase
        .from('sie_account_mappings')
        .delete()
        .eq('company_id', companyId)

      if (error) {
        return NextResponse.json({ error: error.message }, { status: 500 })
      }
    }

    return NextResponse.json({ success: true })
  },
  { requireWrite: true },
)
