import { NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'
import { validateBody } from '@/lib/api/validate'

const BodySchema = z.object({
  limit: z.number().int().min(1).max(200).optional().default(50),
})

/**
 * POST /api/workspace/demote-sandbox — sandbox only: posted → draft for Att bokföra practice.
 */
export async function POST(request: Request) {
  const supabase = await createClient()
  const {
    data: { user },
  } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)

  const { data: settings } = await supabase
    .from('company_settings')
    .select('is_sandbox')
    .eq('company_id', companyId)
    .maybeSingle()

  if (!settings?.is_sandbox) {
    return NextResponse.json(
      { error: 'Only sandbox companies can demote posted vouchers to drafts' },
      { status: 403 },
    )
  }

  const validation = await validateBody(request, BodySchema)
  if (!validation.success) return validation.response

  const { data, error } = await supabase.rpc('demote_sandbox_vouchers_to_draft', {
    p_company_id: companyId,
    p_limit: validation.data.limit,
  })

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 400 })
  }

  return NextResponse.json({ data })
}
