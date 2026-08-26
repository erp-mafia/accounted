import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { findCounterpartyTemplate } from '@/lib/bookkeeping/counterparty-templates'
import type { Transaction } from '@/types'

export const GET = withRouteContext(
  'counterparty_template.list',
  async (request, { supabase, companyId }) => {
    // ?counterparty=<raw name> switches to single-match mode: run the same
    // tiered matcher (alias / normalized / token-subset / fuzzy) the booking
    // flows use, against a name instead of a transaction. The matcher only
    // reads `merchant_name || description` and `id` off the transaction, so a
    // probe object is sufficient; building a name-based variant of the matcher
    // here would just drift from the real one.
    const counterparty = new URL(request.url).searchParams.get('counterparty')?.trim()
    if (counterparty) {
      if (counterparty.length > 200) {
        return NextResponse.json({ error: 'counterparty too long' }, { status: 400 })
      }
      const probe = { id: 'probe', merchant_name: null, description: counterparty } as unknown as Transaction
      const match = await findCounterpartyTemplate(supabase, companyId, probe)
      return NextResponse.json({
        data: match
          ? { template: match.template, match_method: match.matchMethod, confidence: match.confidence }
          : null,
      })
    }

    const { data, error } = await supabase
      .from('categorization_templates')
      .select('*')
      .eq('company_id', companyId)
      .eq('is_active', true)
      .order('occurrence_count', { ascending: false })

    if (error) return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })

    return NextResponse.json({ data })
  },
)

export const DELETE = withRouteContext(
  'counterparty_template.delete',
  async (request, { supabase, companyId }) => {
    let id: string | undefined
    try {
      const body = await request.json()
      id = body?.id
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }
    if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })

    const { error } = await supabase
      .from('categorization_templates')
      .update({ is_active: false })
      .eq('id', id)
      .eq('company_id', companyId)

    if (error) return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })

    return NextResponse.json({ data: { success: true } })
  },
  { requireWrite: true },
)
