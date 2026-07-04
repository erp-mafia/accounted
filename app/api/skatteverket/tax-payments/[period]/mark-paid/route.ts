import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { requireCompanyId } from '@/lib/company/context'
import { requireWritePermission } from '@/lib/auth/require-write'

ensureInitialized()

/**
 * Mark the AGI period's tax payment (skatt + avgifter) as paid.
 *
 * This is a manual confirmation by the user: bank reconciliation against
 * Skattekontot transactions can also flip this flag automatically (handled
 * elsewhere via the Skattekonto sync).
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ period: string }> }
) {
  const { period } = await params
  const periodMatch = /^(\d{4})-(\d{2})$/.exec(period)
  if (!periodMatch) {
    return NextResponse.json(
      { error: 'Ogiltig period. Använd YYYY-MM (t.ex. 2026-04).' },
      { status: 400 }
    )
  }
  const periodYear = parseInt(periodMatch[1], 10)
  const periodMonth = parseInt(periodMatch[2], 10)

  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const writeCheck = await requireWritePermission(supabase, user.id)
  if (!writeCheck.ok) return writeCheck.response

  const companyId = await requireCompanyId(supabase, user.id)

  const { data: agi } = await supabase
    .from('agi_declarations')
    .select('id')
    .eq('company_id', companyId)
    .eq('period_year', periodYear)
    .eq('period_month', periodMonth)
    .single()

  if (!agi) {
    return NextResponse.json(
      { error: `Ingen AGI för perioden ${period}.` },
      { status: 404 }
    )
  }

  const { error } = await supabase
    .from('agi_declarations')
    .update({ tax_paid_at: new Date().toISOString() })
    .eq('id', agi.id)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data: { ok: true } })
}
