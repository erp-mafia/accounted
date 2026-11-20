/**
 * The förenklat årsbokslut (BFNAR 2010:1) of an ideell förening as a v1
 * report and an MCP read. Rules live in lib/bokslut/forenklat-arsbokslut;
 * the dashboard routes under
 * /api/bookkeeping/fiscal-periods/[id]/forenklat-arsbokslut call the same
 * service, so the app, v1 and MCP say the same.
 *
 * The PDF is a v1-only file route (GET .../reports/forenklat-arsbokslut/pdf):
 * an MCP read answers the JSON and names that path, never the bytes.
 *
 * No write here, on purpose: the eligibility confirmation is a member's
 * attestation that the förening meets BFL 6 kap. 3 § (a person, not an
 * agent, answers it), and the notes and signatories are set in the app.
 */
import { z } from 'zod'
import { defineOperation, type OperationOutcome } from './types'

/*
 * The service loads on first use: this module sits in the operation registry,
 * which the MCP server and the commit path import, and the report graph (and
 * react-pdf behind the file) is nothing those paths need.
 */
const service = () => import('@/lib/bokslut/forenklat-arsbokslut/service')

/**
 * The service returns interfaces; the output schema below documents them for
 * OpenAPI and the MCP outputSchema (neither door re-validates the payload).
 * TypeScript does not treat an interface as assignable to the schema's
 * loose-object type, so the outcome is re-typed here, unchanged.
 */
function asDocumented<O>(outcome: OperationOutcome<unknown>): OperationOutcome<O> {
  return outcome as OperationOutcome<O>
}

const META = { request_id: 'req_…', api_version: '2026-05-12' }
const V1 = '/api/v1/companies'

const Amounts = z.object({ current: z.number(), previous: z.number().nullable() })

const StatementRow = z
  .object({
    kind: z.enum(['rubrik', 'post', 'summa']),
    key: z.string(),
    label: z.string().describe('The bilaga 2 name of the rubrik, post or summeringsrad.'),
    current: z.number().nullable(),
    previous: z.number().nullable(),
    accounts: z
      .array(
        z.object({
          account_number: z.string(),
          account_name: z.string(),
          current: z.number(),
          previous: z.number().nullable(),
        }),
      )
      .optional()
      .describe('Posts only: the accounts behind the amount. Never printed on the document.'),
  })
  .loose()

const Check = z.object({ code: z.string(), message: z.string() })

const Period = z.object({
  fiscal_period_id: z.string().uuid(),
  name: z.string(),
  period_start: z.string(),
  period_end: z.string(),
})

export const reportsForenklatArsbokslut = defineOperation({
  id: 'reports.forenklat-arsbokslut',
  kind: 'read',
  scope: 'reports:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Förenklat årsbokslut (ideell förening, BFNAR 2010:1): resultaträkning and balansräkning for a räkenskapsår.',
    description:
      'The förenklat årsbokslut an ideell förening closes its books with (BFL 6 kap. 3 § andra stycket, 6 §), in the uppställningsform of BFNAR 2010:1 bilaga 2: the resultaträkning from the books before the resultatavslut and the balansräkning after it, each row with the comparison year, empty rows left out, plus the accounts behind each post. blockers say why the document cannot be made yet (the year not closed, an avsättning or another form\'s equity account booked, a balansräkning that does not balance, årets över-/underskott not equal to 2069, the eligibility not confirmed); warnings flag what needs a look (förutbetalda or invoiced medlemsavgifter, nettoomsättning above three million kronor, the comparison year). The PDF for the styrelse to sign is served by GET /reports/forenklat-arsbokslut/pdf; pdf_file names that path. Read-only.',
    useWhen: 'An ideell förening\'s year is closed and its förenklat årsbokslut is to be checked, prepared or signed.',
    doNotUseFor:
      'An aktiebolag or ekonomisk förening (the årsredovisning), an enskild firma (GET /reports/ne-bilaga), INK3, or confirming the eligibility (a person does that in the app).',
    pitfalls: [
      'Only for a form that prepares one (ideell förening): another form answers 400 FORENKLAT_ARSBOKSLUT_WRONG_LEGAL_FORM.',
      'Amounts are kronor with öre. In the resultaträkning an income is positive and a cost negative, as in BFN\'s example; in the balansräkning every side is positive.',
      'A non-empty blockers list means GET .../pdf answers 422 FORENKLAT_ARSBOKSLUT_BLOCKED: correct the books or confirm the eligibility in the app, do not retry.',
      'The mapping of BAS accounts to bilaga 2 posts is the product\'s own (BAS publishes none for K1 föreningar) and awaits an accountant\'s review.',
    ],
    example: {
      request: { period_id: '7c2b…' },
      response: {
        data: {
          regelverk: 'BFNAR 2010:1',
          company: { name: 'Föreningen', org_number: '8020001234' },
          fiscal_period: { fiscal_period_id: '7c2b…', name: '2026', period_start: '2026-01-01', period_end: '2026-12-31', is_closed: true },
          previous_period: { fiscal_period_id: '5a1d…', name: '2025', period_start: '2025-01-01', period_end: '2025-12-31' },
          resultatrakning: [
            { kind: 'rubrik', key: 'intakter', label: 'Intäkter', current: null, previous: null },
            { kind: 'post', key: 'medlemsavgifter', label: 'Medlemsavgifter', current: 210000, previous: 205000 },
          ],
          totals: { aretsOverUnderskott: { current: -23000, previous: 92000 } },
          eligibility: { confirmed: true, confirmed_at: '2027-03-01T10:00:00Z' },
          blockers: [],
          warnings: [],
          pdf_file: { download: '/api/v1/companies/…/reports/forenklat-arsbokslut/pdf?period_id=7c2b…', content_type: 'application/pdf' },
        },
        meta: META,
      },
    },
  },
  input: z.object({
    period_id: z.string().uuid().describe('The fiscal period (räkenskapsår) id, from GET /fiscal-periods.'),
  }),
  output: z
    .object({
      regelverk: z.literal('BFNAR 2010:1'),
      company: z.object({ name: z.string(), org_number: z.string().nullable() }),
      fiscal_period: Period.extend({ is_closed: z.boolean() }),
      previous_period: Period.nullable(),
      resultatrakning: z.array(StatementRow),
      balansrakning: z.array(StatementRow),
      totals: z.object({
        aretsOverUnderskott: Amounts,
        summaTillgangar: Amounts,
        summaEgetKapitalOchSkulder: Amounts,
        nettoomsattning: Amounts,
      }),
      eligibility: z.object({ confirmed: z.boolean(), confirmed_at: z.string().nullable() }),
      notes: z.string().nullable(),
      signatories: z.array(z.object({ name: z.string(), role: z.string().nullable() })),
      blockers: z.array(Check),
      warnings: z.array(Check),
      pdf_file: z
        .object({
          download: z.string().describe('The v1 path (GET, reports:read) that returns the PDF. Not served over MCP.'),
          content_type: z.literal('application/pdf'),
        })
        .describe('Where to fetch the document for the styrelse to sign.'),
    })
    .loose(),
  errorCodes: ['FISCAL_PERIOD_NOT_FOUND', 'FORENKLAT_ARSBOKSLUT_WRONG_LEGAL_FORM', 'REPORT_GENERATION_FAILED'],
  http: { method: 'GET', path: '/api/v1/companies/:companyId/reports/forenklat-arsbokslut' },
  mcp: {
    name: 'gnubok_get_forenklat_arsbokslut',
    title: 'Förenklat Årsbokslut (Ideell Förening)',
    description:
      'Ideell förening förenklat årsbokslut (BFNAR 2010:1) for a räkenskapsår: resultaträkning and balansräkning in the bilaga 2 layout with comparatives, blockers and warnings. The PDF is a v1 download (pdf_file.download).',
    keywords: ['förenklat årsbokslut', 'årsbokslut', 'ideell förening', 'k1', 'bfnar 2010:1', 'förening bokslut'],
  },
  run: async (ctx, { period_id }) => {
    const outcome = await (await service()).getForenklatArsbokslut(ctx, period_id)
    if (!outcome.ok || outcome.dryRun) return asDocumented(outcome)
    return asDocumented({
      ok: true,
      data: {
        ...outcome.data,
        pdf_file: {
          download: `${V1}/${ctx.companyId}/reports/forenklat-arsbokslut/pdf?period_id=${period_id}`,
          content_type: 'application/pdf' as const,
        },
      },
    })
  },
})
