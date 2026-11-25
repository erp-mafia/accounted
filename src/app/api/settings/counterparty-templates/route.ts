import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { findCounterpartyTemplate } from '@/lib/bookkeeping/counterparty-templates'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { renameCounterpartyTemplate } from '@/lib/rules/service'
import type { CategorizationTemplate, Transaction } from '@/types'

const RenameCounterpartyTemplateSchema = z.object({
  id: z.string().uuid(),
  counterparty_name: z.string().trim().min(1).max(100),
})

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

    // Paged: one company holds more than PostgREST's 1,000-row page; id
    // breaks occurrence_count ties so the pages never overlap or skip.
    let data: CategorizationTemplate[]
    try {
      data = await fetchAllRows<CategorizationTemplate>(({ from, to }) =>
        supabase
          .from('categorization_templates')
          .select('*')
          .eq('company_id', companyId)
          .eq('is_active', true)
          .order('occurrence_count', { ascending: false })
          .order('id')
          .range(from, to),
      )
    } catch (error) {
      return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })
    }

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

/**
 * PATCH /api/settings/counterparty-templates
 * Rename a learned template (lib/rules/service.ts renameCounterpartyTemplate,
 * the same rename gnubok_rename_counterparty_template stages). The old name
 * is kept as an alias so the matcher and the learn path keep landing on this
 * row for the merchant it was learned from.
 */
export const PATCH = withRouteContext(
  'counterparty_template.rename',
  async (request, { supabase, companyId, log, requestId }) => {
    const validation = await validateBody(request, RenameCounterpartyTemplateSchema)
    if (!validation.success) return validation.response

    let outcome: Awaited<ReturnType<typeof renameCounterpartyTemplate>>
    try {
      outcome = await renameCounterpartyTemplate(supabase, companyId, validation.data.id, validation.data.counterparty_name)
    } catch (error) {
      return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })
    }
    if (outcome.ok) return NextResponse.json({ data: outcome.template })
    if (outcome.reason === 'NAME_TOO_SHORT') {
      return errorResponseFromCode('VALIDATION_ERROR', log, {
        requestId,
        messageSv: 'Namnet måste vara minst två tecken',
        messageEn: 'The name must be at least two characters',
      })
    }
    if (outcome.reason === 'NOT_FOUND') {
      return errorResponseFromCode('NOT_FOUND', log, {
        requestId,
        messageSv: 'Mallen hittades inte',
        messageEn: 'Template not found',
      })
    }
    return errorResponseFromCode('CONFLICT', log, {
      requestId,
      messageSv: 'Det finns redan en mall med det här namnet',
      messageEn: 'A template with this name already exists',
    })
  },
  { requireWrite: true },
)
