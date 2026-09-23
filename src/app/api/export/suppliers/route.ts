import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { textColumn, integerColumn } from '@/lib/reports/xlsx-export'
import { buildRegisterExport, parseExportFormat, todayIso } from '@/lib/export/register-export'
import type { Supplier } from '@/types'

/**
 * GET /api/export/suppliers[?format=csv]
 *
 * Downloads the supplier register as xlsx (default) or csv. Read-only: viewers
 * may export. Headers match the supplier importer's detector keywords so files
 * round-trip.
 */
export const GET = withRouteContext(
  'supplier.export',
  async (request, ctx) => {
    const { supabase, companyId, log, requestId } = ctx

    const format = parseExportFormat(new URL(request.url).searchParams.get('format'))

    try {
      const { data: companyRow } = await supabase
        .from('company_settings')
        .select('company_name')
        .eq('company_id', companyId)
        .single()

      const suppliers = (await fetchAllRows(({ from, to }) =>
        supabase
          .from('suppliers')
          .select('*')
          .eq('company_id', companyId)
          .order('name', { ascending: true })
          .range(from, to),
      )) as unknown as Supplier[]

      const { buffer, contentType, filename } = buildRegisterExport(
        [
          {
            name: 'Leverantörer',
            columns: [
              textColumn('Namn'),
              textColumn('Org-/personnummer'),
              textColumn('Leverantörstyp'),
              textColumn('E-post'),
              textColumn('Telefon'),
              textColumn('Adress'),
              textColumn('Adressrad 2'),
              textColumn('Postnummer'),
              textColumn('Ort'),
              textColumn('Land'),
              textColumn('VAT-nummer'),
              textColumn('Bankgiro'),
              textColumn('Plusgiro'),
              textColumn('Bankkonto'),
              textColumn('IBAN'),
              textColumn('BIC'),
              integerColumn('Betalningsvillkor'),
              textColumn('Valuta'),
              textColumn('Anteckning'),
            ],
            rows: suppliers,
            mapRow: (s) => [
              s.name,
              s.org_number,
              s.supplier_type,
              s.email,
              s.phone,
              s.address_line1,
              s.address_line2,
              s.postal_code,
              s.city,
              s.country,
              s.vat_number,
              s.bankgiro,
              s.plusgiro,
              s.bank_account,
              s.iban,
              s.bic,
              s.default_payment_terms,
              s.default_currency,
              s.notes,
            ],
          },
        ],
        { format, slug: 'leverantorer', companyName: companyRow?.company_name ?? '', date: todayIso() },
      )

      log.info('register exported', { entity: 'suppliers', format, rowCount: suppliers.length })

      return new NextResponse(new Uint8Array(buffer), {
        headers: {
          'Content-Type': contentType,
          'Content-Disposition': `attachment; filename="${filename}"`,
          'Cache-Control': 'no-store',
        },
      })
    } catch (err) {
      log.error('supplier export failed', err as Error)
      return errorResponse(err, log, { requestId })
    }
  },
)
