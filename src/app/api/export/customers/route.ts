import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { errorResponse } from '@/lib/errors/get-structured-error'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { textColumn, integerColumn } from '@/lib/reports/xlsx-export'
import { buildRegisterExport, parseExportFormat, todayIso } from '@/lib/export/register-export'
import { maskStoredCustomerPersonalNumber } from '@/lib/customers/protect-personal-number'
import { maskCustomerPersonalNumber } from '@/lib/customers/mask-personal-number'
import { orgNumberIsPersonalIdentifier } from '@/lib/customers/personal-number-shape'
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
              // Appended, not inserted next to the name: the existing column
              // order is what anyone's downstream sheet or script reads by
              // position.
              textColumn('Kundnummer'),
            ],
            rows: customers,
            mapRow: (c) => [
              c.name,
              // personal_number holds AES-256-GCM ciphertext (migration
              // 20260726110000). Decrypt-and-mask exactly like the customer
              // read surfaces: the export shows a member the same
              // '********-1234' the UI shows, never the ciphertext and never
              // the full personnummer (GDPR Art. 5(1)(f) data minimization on
              // a file that leaves the system). Decrypt failures fall back to
              // a placeholder mask instead of aborting the export.
              //
              // org_number gets the same treatment when it IS a personnummer:
              // an enskild firma has no org number of its own, and a legacy
              // individual row can still carry one there (#2367). The column
              // is the identifier either way, so it is masked, not dropped.
              orgNumberIsPersonalIdentifier(c.customer_type, c.org_number)
                ? maskCustomerPersonalNumber(c.org_number)
                : c.org_number ?? maskStoredCustomerPersonalNumber(c.personal_number),
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
              c.customer_number,
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
