import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { textColumn, integerColumn } from '@/lib/reports/xlsx-export'
import { buildRegisterExport, parseExportFormat, todayIso } from '@/lib/export/register-export'
import type { Customer } from '@/types'

/**
 * GET /api/export/customers[?format=csv]
 *
 * Downloads the customer register as xlsx (default) or csv. Read-only: viewers
 * may export. Headers match the customer importer's detector keywords so files
 * round-trip.
 */
export const GET = withRouteContext(
  'customer.export',
  async (request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    const format = parseExportFormat(new URL(request.url).searchParams.get('format'))

    try {
      const { data: companyRow } = await supabase
        .from('company_settings')
        .select('company_name')
        .eq('company_id', companyId)
        .single()

      const customers = (await fetchAllRows(({ from, to }) =>
        supabase
          .from('customers')
          .select('*')
          .eq('company_id', companyId)
          .order('name', { ascending: true })
          .range(from, to),
      )) as unknown as Customer[]

      const { buffer, contentType, filename } = buildRegisterExport(
        [
          {
            name: 'Kunder',
            columns: [
              textColumn('Namn'),
              textColumn('Org-/personnummer'),
              textColumn('Kundtyp'),
              textColumn('E-post'),
              textColumn('Telefon'),
              textColumn('Adress'),
              textColumn('Adressrad 2'),
              textColumn('Postnummer'),
              textColumn('Ort'),
              textColumn('Land'),
              textColumn('VAT-nummer'),
              integerColumn('Betalningsvillkor'),
              textColumn('Anteckning'),
            ],
            rows: customers,
            mapRow: (c) => [
              c.name,
              c.org_number ?? c.personal_number,
              c.customer_type,
              c.email,
              c.phone,
              c.address_line1,
              c.address_line2,
              c.postal_code,
              c.city,
              c.country,
              c.vat_number,
              c.default_payment_terms,
              c.notes,
            ],
          },
        ],
        { format, slug: 'kunder', companyName: companyRow?.company_name ?? '', date: todayIso() },
      )

      log.info('register exported', { entity: 'customers', format, rowCount: customers.length })

      return new NextResponse(new Uint8Array(buffer), {
        headers: {
          'Content-Type': contentType,
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Cache-Control': 'no-store',
        },
      })
    } catch (err) {
      log.error('customer export failed', err as Error)
      return errorResponse(err, log, { requestId })
    }
  },
)
