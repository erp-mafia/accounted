/**
 * Dröjsmålsränta through the machine doors (lib/invoices/late-payment-interest-report.ts):
 * the interest each customer invoice paid late has earned, and what each
 * overdue unpaid invoice has accrued. Reads only; the dashboard route
 * /api/invoices/late-payment-interest calls the same service.
 */
import { z } from 'zod'
import { isoDateSchema } from '@/lib/invariants/zod'
import { todayIsoStockholm } from '@/lib/dates/iso'
import { getLatePaymentInterestReport } from '@/lib/invoices/late-payment-interest-report'
import { defineOperation } from './types'

const META = { request_id: 'req_…', api_version: '2026-05-12' }

export const latePaymentInterestInputSchema = z.object({
  as_of: isoDateSchema
    .optional()
    .describe('Compute up to this date (YYYY-MM-DD): payments after it are ignored and open invoices accrue to it. Default today, Europe/Stockholm.'),
})

const PaidLate = z.object({
  invoice_id: z.string().uuid(),
  invoice_number: z.string(),
  customer_name: z.string().nullable(),
  currency: z.string(),
  due_date: z.string(),
  paid_late_amount: z.number().describe('Sum of the payments that arrived after the due date, in the invoice currency.'),
  last_payment_date: z.string(),
  days_late: z.number().describe('Days late of the latest late payment.'),
  interest: z.number().describe('Interest earned, in the invoice currency, rounded to öre.'),
})

const OverdueOpen = z.object({
  invoice_id: z.string().uuid(),
  invoice_number: z.string(),
  customer_name: z.string().nullable(),
  currency: z.string(),
  due_date: z.string(),
  remaining_amount: z.number(),
  days_overdue: z.number(),
  interest: z.number().describe('Interest accrued from the due date up to as_of, in the invoice currency.'),
})

export const latePaymentInterestOutputSchema = z.object({
  as_of: z.string(),
  rate: z.number().describe('The yearly rate in effect on as_of, as a fraction (0.10 = 10%).'),
  rate_is_override: z.boolean().describe("True when the company's own rate (reminder_interest_rate_override) replaces the statutory one."),
  paid_late: z.array(PaidLate),
  overdue_open: z.array(OverdueOpen),
  totals: z.array(
    z.object({
      currency: z.string(),
      paid_late_interest: z.number(),
      overdue_interest: z.number(),
    }),
  ),
})

export const invoicesLatePaymentInterestGet = defineOperation({
  id: 'invoices.late-payment-interest.get',
  kind: 'read',
  scope: 'invoices:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Dröjsmålsränta per customer invoice: interest earned by invoices paid late, and interest accrued on overdue unpaid ones.',
    description:
      'Statutory late-payment interest (Räntelagen 6 §): Riksbankens referensränta for each half-year plus eight percentage points, ' +
      "or the company's own rate when it set one, on 365 days. Each payment that arrived after the due date earns interest on its own " +
      'amount from the due date to its payment date; an open invoice accrues on its remaining amount up to as_of. Only payments booked ' +
      'in Accounted count: payment dates that came with an import, payments linked to imported verifikat, credit notes, customer losses ' +
      'and collection-provider payments are left out. Amounts are in each invoice\'s currency. Nothing is booked or sent.',
    useWhen: 'Preparing a räntefaktura (interest invoice) after late payments, or checking what an overdue customer owes in interest.',
    doNotUseFor: 'Listing unpaid invoices without interest (GET /invoices) or invoices that could go to collection (GET /collections/candidates).',
    pitfalls: [
      'An invoice paid late before the company moved to Accounted is not listed: its payment date came with the import.',
      'The interest is per invoice currency; totals are grouped by currency, never converted.',
    ],
    example: {
      response: {
        data: {
          as_of: '2026-10-26',
          rate: 0.1,
          rate_is_override: false,
          paid_late: [
            {
              invoice_id: '7d1e…',
              invoice_number: 'F-1042',
              customer_name: 'Kund AB',
              currency: 'SEK',
              due_date: '2026-09-01',
              paid_late_amount: 12500,
              last_payment_date: '2026-09-21',
              days_late: 20,
              interest: 68.49,
            },
          ],
          overdue_open: [],
          totals: [{ currency: 'SEK', paid_late_interest: 68.49, overdue_interest: 0 }],
        },
        meta: META,
      },
    },
  },
  input: latePaymentInterestInputSchema,
  output: latePaymentInterestOutputSchema,
  http: { method: 'GET', path: '/api/v1/companies/:companyId/invoices/late-payment-interest' },
  mcp: {
    name: 'gnubok_get_late_payment_interest',
    title: 'Get Late Payment Interest',
    description:
      'Dröjsmålsränta per customer invoice: interest earned by invoices paid late (payments booked in Accounted only) and interest accrued on overdue unpaid ones, at referensränta + 8 pp or the company rate.',
    visibility: 'search',
    keywords: ['dröjsmålsränta', 'räntefaktura', 'ränta', 'betald för sent', 'sen betalning', 'förfallna fakturor', 'referensränta', 'räntelagen'],
  },
  run: async (ctx, input) => ({
    ok: true,
    data: await getLatePaymentInterestReport(ctx.supabase, ctx.companyId, input.as_of ?? todayIsoStockholm()),
  }),
})
