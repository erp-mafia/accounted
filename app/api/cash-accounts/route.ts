import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { getActiveCompanyId } from '@/lib/company/context'
import { listForCompany } from '@/lib/cash-accounts/service'

/**
 * GET /api/cash-accounts
 *
 * Returns the active company's cash accounts (cash_accounts table). Used by the
 * reconciliation CashAccountSelector (Item 5) and any other surface that needs
 * the canonical list of routable cash accounts. UI panels that just display PSD2
 * connection state may still read bank_connections.accounts_data until that
 * column is dropped in a follow-up migration.
 *
 * Query params:
 *   - enabled_only=true → only accounts with enabled=true (default returns all)
 */
export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const companyId = await getActiveCompanyId(supabase, user.id)
  if (!companyId) {
    return NextResponse.json({ error: 'No company context' }, { status: 400 })
  }

  const url = new URL(request.url)
  const enabledOnly = url.searchParams.get('enabled_only') === 'true'

  const accounts = await listForCompany(supabase, companyId, { enabledOnly })
  return NextResponse.json({ data: accounts })
}
