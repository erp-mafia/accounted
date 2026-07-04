import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { textColumn, currencyColumn, integerColumn } from '@/lib/reports/xlsx-export'
import { buildRegisterExport, parseExportFormat, todayIso } from '@/lib/export/register-export'
import type { Article } from '@/types'

/**
 * GET /api/export/articles[?format=csv][&include_inactive=1]
 *
 * Downloads the article register as xlsx (default) or csv. Read-only: viewers
 * may export. Column headers match the article importer's detector keywords so
 * the file round-trips (export → edit → re-import).
 */
export const GET = withRouteContext(
  'article.export',
  async (request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    const url = new URL(request.url)
    const format = parseExportFormat(url.searchParams.get('format'))
    const includeInactive = url.searchParams.get('include_inactive') === '1'

    try {
      const { data: companyRow } = await supabase
        .from('company_settings')
        .select('company_name')
        .eq('company_id', companyId)
        .single()

      const articles = (await fetchAllRows(({ from, to }) => {
        let query = supabase
          .from('articles')
          .select('*')
          .eq('company_id', companyId)
        if (!includeInactive) query = query.eq('active', true)
        return query.order('name', { ascending: true }).range(from, to)
      })) as unknown as Article[]

      const { buffer, contentType, filename } = buildRegisterExport(
        [
          {
            name: 'Artiklar',
            columns: [
              textColumn('Artikelnummer'),
              textColumn('Benämning'),
              textColumn('Benämning (engelska)'),
              textColumn('Typ'),
              textColumn('Enhet'),
              currencyColumn('Försäljningspris'),
              integerColumn('Moms %'),
              textColumn('Försäljningskonto'),
              currencyColumn('Inköpspris'),
              textColumn('EAN'),
              textColumn('ROT/RUT'),
              textColumn('Anteckning'),
            ],
            rows: articles,
            mapRow: (a) => [
              a.article_number,
              a.name,
              a.name_en,
              a.type,
              a.unit,
              a.price_excl_vat,
              a.vat_rate,
              a.revenue_account,
              a.cost_price,
              a.ean,
              a.housework_type,
              a.notes,
            ],
          },
        ],
        { format, slug: 'artiklar', companyName: companyRow?.company_name ?? '', date: todayIso() },
      )

      // Audit trail: who exported what, when (sensitive bulk register download).
      log.info('register exported', { entity: 'articles', format, rowCount: articles.length })

      return new NextResponse(new Uint8Array(buffer), {
        headers: {
          'Content-Type': contentType,
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Cache-Control': 'no-store',
        },
      })
    } catch (err) {
      log.error('article export failed', err as Error)
      return errorResponse(err, log, { requestId })
    }
  },
)
