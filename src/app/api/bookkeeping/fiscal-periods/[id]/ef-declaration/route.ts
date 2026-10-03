import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateQuery } from '@/lib/api/validate'
import { EfDeclarationPreviewQuerySchema } from '@/lib/api/schemas'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { computeEfDeclarationPreview } from '@/lib/bokslut/enskild-firma/ef-declaration-preview'

/**
 * Räntefördelning needs the kapitalunderlag, which the books cannot give: an
 * empty field means the item is missing from the preview, not zero. A
 * negative kapitalunderlag below the threshold makes it mandatory, so the
 * owner is asked to enter the figure even when it is 0 or negative.
 */
const KAPITALUNDERLAG_MISSING =
  'Kapitalunderlag saknas: räntefördelning beräknas inte. Fyll i kapitalunderlaget vid årets ingång, även om det är 0 eller negativt.'

/**
 * The year-end wizard's NE-bilaga step (EfDeclarationSection). Read-only:
 * egenavgifter, räntefördelning, periodiseringsfond and expansionsfond are
 * declaration-only and never booked. Same computation as the MCP tool
 * gnubok_preview_ef_declaration; a form that does not file NE-bilagan gets
 * EF_DECLARATION_WRONG_LEGAL_FORM (400) from computeEfDeclarationPreview.
 */
export const GET = withRouteContext<{ params: Promise<{ id: string }> }>(
  'period.ef_declaration_preview',
  async (request, { supabase, companyId, log, requestId }, { params }) => {
    const { id } = await params

    const query = validateQuery(request, EfDeclarationPreviewQuerySchema, {
      log,
      operation: 'period.ef_declaration_preview',
    })
    if (!query.success) return query.response

    const { data: period, error: periodError } = await supabase
      .from('fiscal_periods')
      .select('id')
      .eq('id', id)
      .eq('company_id', companyId)
      .maybeSingle()
    if (periodError) throw periodError
    if (!period) return errorResponseFromCode('FISCAL_PERIOD_NOT_FOUND', log, { requestId })

    const preview = await computeEfDeclarationPreview(supabase, companyId, id, query.data)

    // Same definition as the entry-count route: a reversed entry is still in
    // the books. Zero tells the owner the surplus is empty because nothing is
    // booked yet, not because the calculation failed.
    const { count, error: countError } = await supabase
      .from('journal_entries')
      .select('id', { count: 'exact', head: true })
      .eq('company_id', companyId)
      .eq('fiscal_period_id', id)
      .in('status', ['posted', 'reversed'])
    if (countError) throw countError

    return NextResponse.json({
      data: {
        ...preview,
        postedEntryCount: count ?? 0,
        inputWarnings: query.data.kapitalunderlag === undefined ? [KAPITALUNDERLAG_MISSING] : [],
      },
    })
  },
)
