import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { findCounterpartyTemplate } from '@/lib/bookkeeping/counterparty-templates'
import type { CategorizationTemplate, Transaction } from '@/types'

const RenameCounterpartyTemplateSchema = z.object({
  id: z.string().uuid(),
  counterparty_name: z.string().trim().min(1).max(100),
})

/**
 * Stored names are lowercase, single-spaced keys (the matcher compares them
 * against normalized bank descriptions). A user-typed name gets the same
 * shape; display re-capitalizes through formatCounterpartyName().
 */
function toTemplateKey(input: string): string {
  return input.toLowerCase().replace(/\s+/g, ' ').trim()
}

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

/**
 * PATCH /api/settings/counterparty-templates
 * Rename a learned template. The old name is kept as an alias so both the
 * matcher (alias tier) and the learn path (findTemplateByKey) keep landing on
 * this row for the merchant it was learned from.
 */
export const PATCH = withRouteContext(
  'counterparty_template.rename',
  async (request, { supabase, companyId, log, requestId }) => {
    const validation = await validateBody(request, RenameCounterpartyTemplateSchema)
    if (!validation.success) return validation.response

    const { id } = validation.data
    const newName = toTemplateKey(validation.data.counterparty_name)
    if (newName.length < 2) {
      return errorResponseFromCode('VALIDATION_ERROR', log, {
        requestId,
        messageSv: 'Namnet måste vara minst två tecken',
        messageEn: 'The name must be at least two characters',
      })
    }

    const { data: existing, error: fetchError } = await supabase
      .from('categorization_templates')
      .select('*')
      .eq('id', id)
      .eq('company_id', companyId)
      .eq('is_active', true)
      .maybeSingle()
    if (fetchError) {
      return NextResponse.json({ error: getUserErrorMessage(fetchError) }, { status: 500 })
    }
    if (!existing) {
      return errorResponseFromCode('NOT_FOUND', log, {
        requestId,
        messageSv: 'Mallen hittades inte',
        messageEn: 'Template not found',
      })
    }
    const current = existing as CategorizationTemplate
    if (current.counterparty_name === newName) {
      return NextResponse.json({ data: current })
    }

    // (company_id, counterparty_name) is UNIQUE and includes soft-deleted
    // rows. An active twin is a real conflict the user can see and resolve;
    // an inactive twin is invisible to them, so it is removed instead of
    // blocking the rename (a learned pattern, not a retention-bound record).
    const { data: twin, error: twinError } = await supabase
      .from('categorization_templates')
      .select('id, is_active')
      .eq('company_id', companyId)
      .eq('counterparty_name', newName)
      .neq('id', id)
      .maybeSingle()
    if (twinError) {
      return NextResponse.json({ error: getUserErrorMessage(twinError) }, { status: 500 })
    }
    if (twin?.is_active) {
      return errorResponseFromCode('CONFLICT', log, {
        requestId,
        messageSv: 'Det finns redan en mall med det här namnet',
        messageEn: 'A template with this name already exists',
      })
    }
    if (twin) {
      const { error: purgeError } = await supabase
        .from('categorization_templates')
        .delete()
        .eq('id', twin.id)
        .eq('company_id', companyId)
      if (purgeError) {
        return NextResponse.json({ error: getUserErrorMessage(purgeError) }, { status: 500 })
      }
    }

    const aliases = [...(current.counterparty_aliases || [])]
    if (!aliases.includes(current.counterparty_name)) aliases.push(current.counterparty_name)

    const { data: updated, error: updateError } = await supabase
      .from('categorization_templates')
      .update({ counterparty_name: newName, counterparty_aliases: aliases })
      .eq('id', id)
      .eq('company_id', companyId)
      .select('*')
      .single()
    if (updateError) {
      // Lost the race against another rename or the learn path: the unique
      // (company_id, counterparty_name) index rejected the new name.
      if ((updateError as { code?: string }).code === '23505') {
        return errorResponseFromCode('CONFLICT', log, {
          requestId,
          messageSv: 'Det finns redan en mall med det här namnet',
          messageEn: 'A template with this name already exists',
        })
      }
      return NextResponse.json({ error: getUserErrorMessage(updateError) }, { status: 500 })
    }

    return NextResponse.json({ data: updated })
  },
  { requireWrite: true },
)
