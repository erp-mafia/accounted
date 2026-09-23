import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { PartyAliasActionSchema } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'

interface LiveAlias {
  id: string
  alias_key: string
  sample_text: string
  display_name: string | null
  kind: string
  rail: string | null
  country: string | null
  what: string | null
}

const NAMELESS_KINDS = new Set(['payroll', 'transfer', 'category', 'unsure'])

/**
 * POST /api/parties/aliases: a person corrects what the bank strings mean.
 *
 * The live rows for the keys are superseded and stamped with the outcome
 * (agree when the person kept the name, disagree otherwise), and one new row
 * per key records the person's answer with confidence 1. A rename links to
 * the party that already carries the name, when there is one. The resolver
 * never rewrites a person's row: it only reads strings without a live alias.
 */
export const POST = withRouteContext('parties.aliases', async (request, { supabase, companyId, user, log, requestId }) => {
  const validated = await validateBody(request, PartyAliasActionSchema, { log, operation: 'parties.aliases' })
  if (!validated.success) return validated.response
  const { aliasKeys, action } = validated.data
  const name = validated.data.name?.trim() ?? null

  const { data: liveRows, error: readError } = await supabase
    .from('counterparty_aliases')
    .select('id, alias_key, sample_text, display_name, kind, rail, country, what')
    .eq('company_id', companyId)
    .is('superseded_at', null)
    .in('alias_key', aliasKeys)
  if (readError) {
    log.warn('alias read failed', { message: readError.message })
    return errorResponseFromCode('INTERNAL_ERROR', log, { requestId })
  }
  const live = (liveRows ?? []) as LiveAlias[]
  if (!live.length) return errorResponseFromCode('NOT_FOUND', log, { requestId })

  let partyId: string | null = null
  if (action === 'rename' && name) {
    const { data: party } = await supabase
      .from('parties')
      .select('id')
      .eq('company_id', companyId)
      .is('archived_at', null)
      .is('merged_into', null)
      .ilike('display_name', name)
      .limit(1)
      .maybeSingle()
    partyId = (party as { id: string } | null)?.id ?? null
  }

  const now = new Date().toISOString()
  for (const row of live) {
    const agree = action === 'rename' && !!row.display_name && !!name && row.display_name.trim().toLowerCase() === name.toLowerCase()
    const { error } = await supabase
      .from('counterparty_aliases')
      .update({ superseded_at: now, human_outcome: agree ? 'agree' : 'disagree', outcome_at: now })
      .eq('id', row.id)
      .eq('company_id', companyId)
    if (error) {
      log.warn('alias supersede failed', { message: error.message, id: row.id })
      return errorResponseFromCode('INTERNAL_ERROR', log, { requestId })
    }
  }

  const { error: insertError } = await supabase.from('counterparty_aliases').insert(
    live.map((row) => ({
      company_id: companyId,
      user_id: user.id,
      alias_key: row.alias_key,
      sample_text: row.sample_text,
      party_id: action === 'rename' ? partyId : null,
      display_name: action === 'rename' ? name : null,
      kind: action === 'rename' ? (NAMELESS_KINDS.has(row.kind) ? 'merchant' : row.kind) : 'unsure',
      rail: row.rail,
      country: row.country,
      what: action === 'rename' ? row.what : null,
      source: 'person',
      confidence: 1,
      band: action === 'rename' ? 'link' : 'nil',
      verified: true,
    })),
  )
  if (insertError) {
    log.warn('alias insert failed', { message: insertError.message })
    return errorResponseFromCode('INTERNAL_ERROR', log, { requestId })
  }

  return NextResponse.json({ data: { updated: live.length, partyId } })
})
