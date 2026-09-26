/**
 * Filing and year-end report reads that neither v1 nor MCP served before:
 * INK2, NE-bilaga, periodisk sammanställning, kassaflödesanalys,
 * behandlingshistorik, bokslutsbilagor, the KPI report, resultat per
 * dimension and the audit trail. Rules live in
 * lib/reports/filing-report-service.ts, lib/reports/kpi-report.ts and
 * lib/core/audit/audit-service.ts; the dashboard routes under /api/reports
 * call the same generators.
 *
 * The files Skatteverket takes (INK2 and NE SRU zips, the periodisk
 * sammanställning CSV, the momsdeklaration eSKD XML) are v1-only routes
 * (lib/api/v1/report-file-route.ts): an MCP read answers the JSON and names
 * the v1 path that serves the file, never the bytes.
 *
 * Personal data: for an enskild firma the org number is the owner's
 * personnummer. The JSON these operations answer masks it (owner-identity-mask.ts);
 * the SRU file keeps it, because the file is the filing.
 *
 * No MCP binding, on purpose:
 *   - reports.kpi and reports.dimension-pnl: gnubok_get_kpi_report and
 *     gnubok_get_dimension_pnl already exist (hand-written);
 *   - audit-trail.list: the rows carry whole before/after row snapshots
 *     (company settings, parties, supplier bank details), which is more
 *     personal data than an agent transcript should hold by default.
 */
import { z } from 'zod'
import { isoDateSchema } from '@/lib/invariants/zod'
import { AuditTrailQuerySchema } from '@/lib/api/schemas'
import { BEHANDLINGSHISTORIK_CATEGORIES } from '@/lib/reports/behandlingshistorik-types'
import { maskOwnerPersonnummer, redactPersonnummer } from '@/lib/reports/owner-identity-mask'
import { listAuditLogPage } from '@/lib/core/audit/audit-service'
import { defineOperation, type OperationContext, type OperationOutcome } from './types'
import { getCompanyRole } from '@/lib/auth/require-write'
import { COMPANY_ADMIN_ROLES } from './access'

/**
 * The generators return interfaces; the output schemas below document them
 * for OpenAPI and the MCP outputSchema (neither door re-validates the
 * payload). TypeScript does not treat an interface as assignable to the
 * schema's loose-object type, so the outcome is re-typed here, unchanged.
 */
function asDocumented<O>(outcome: OperationOutcome<unknown>): OperationOutcome<O> {
  return outcome as OperationOutcome<O>
}

/*
 * The report services load on first use: this module sits in the operation
 * registry, which the MCP server and the commit path import, and the
 * generators behind these reads (INK2, NE, KPI, behandlingshistorik, ...)
 * are a large graph nobody else on those paths needs.
 */
const reports = () => import('@/lib/reports/filing-report-service')
const kpi = () => import('@/lib/reports/kpi-report')

/*
 * Qualified identifiers. The machine doors never answer a bare `id` (an
 * agent cannot tell which entity it names; qualified-ids.test.ts), so the
 * generators' nested ids are renamed on the way out: the fiscal year to
 * fiscal_period_id, a behandlingshistorik event to event_id, a bokslutsbilaga
 * sign-off and attachment to signoff_id and attachment_id. The dashboard's
 * own JSON keeps the generator shape.
 */
function qualifyFiscalYear<T extends { fiscalYear: { id: string } }>(declaration: T) {
  const { id, ...rest } = declaration.fiscalYear
  return { ...declaration, fiscalYear: { fiscal_period_id: id, ...rest } }
}

function qualifyPeriod<T extends { period: { id: string } }>(report: T) {
  const { id, ...rest } = report.period
  return { ...report, period: { fiscal_period_id: id, ...rest } }
}

function renameId<T extends { id: string }>(row: T, key: string): Omit<T, 'id'> & Record<string, string> {
  const { id, ...rest } = row
  return { [key]: id, ...rest } as Omit<T, 'id'> & Record<string, string>
}

const META = { request_id: 'req_…', api_version: '2026-05-12' }
const V1 = '/api/v1/companies'

const PERIOD_ID = z
  .string()
  .uuid()
  .describe('The fiscal period (räkenskapsår) id, from GET /fiscal-periods.')

const Rutor = z.record(z.string(), z.union([z.number(), z.string()]))

const Breakdown = z.record(
  z.string(),
  z.object({
    accounts: z.array(z.object({ accountNumber: z.string(), accountName: z.string(), amount: z.number() })),
    total: z.number(),
  }),
)

const FiscalYear = z.object({
  fiscal_period_id: z.string().uuid(),
  name: z.string(),
  start: z.string(),
  end: z.string(),
  isClosed: z.boolean(),
})

const CompanyInfo = z.object({
  companyName: z.string(),
  orgNumber: z.string().nullable(),
  addressLine1: z.string().nullable(),
  postalCode: z.string().nullable(),
  city: z.string().nullable(),
  email: z.string().nullable(),
})

const SruFileRef = z
  .object({
    download: z.string().describe('The v1 path (GET, reports:read) that returns the zip. Not served over MCP.'),
    content_type: z.literal('application/zip'),
    files: z.array(z.string()),
  })
  .describe('Where to fetch INFO.SRU + BLANKETTER.SRU (ISO 8859-1, zipped) for upload at skatteverket.se.')

function sruFileRef(ctx: OperationContext, report: 'ink2' | 'ne-bilaga', periodId: string) {
  return {
    download: `${V1}/${ctx.companyId}/reports/${report}/sru?period_id=${periodId}`,
    content_type: 'application/zip' as const,
    files: ['INFO.SRU', 'BLANKETTER.SRU'],
  }
}

/** The report with the enskild firma owner's personnummer masked, when the company is one. */
async function maskedForSoleTrader<T extends { company: { org_number: string | null } }>(
  ctx: OperationContext,
  report: T,
): Promise<T> {
  if (!report.company.org_number || !(await (await reports()).companyUsesPersonnummer(ctx))) return report
  const redacted = redactPersonnummer(report, report.company.org_number)
  return { ...redacted, company: { ...redacted.company, org_number: maskOwnerPersonnummer(report.company.org_number) } }
}

// ─────────────────────────────────────────────────────────────────
// INK2
// ─────────────────────────────────────────────────────────────────

export const reportsInk2 = defineOperation({
  id: 'reports.ink2',
  kind: 'read',
  scope: 'reports:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'INK2 inkomstdeklaration (aktiebolag): INK2, INK2R and INK2S fields for a räkenskapsår.',
    description:
      'Computes the aktiebolag income tax return from the books, keyed by SRU field code: ink2 (page 1: 7104 överskott / 7114 underskott), ink2r (räkenskapsschema: balance sheet and income statement, the balance sheet from the closed books and the income statement before the resultatavslut) and ink2s (skattemässiga justeringar, including the adjustments saved in the year-end flow), with the per-code account breakdown, totals and warnings. The SRU files for upload at skatteverket.se are served by GET /reports/ink2/sru; sru_file names that path. Read-only.',
    useWhen:
      'Preparing or checking the aktiebolag income tax return after bokslut, or reconciling INK2R figures against the årsredovisning.',
    doNotUseFor:
      'Enskild firma (GET /reports/ne-bilaga), the årsredovisning itself, or submitting to Skatteverket (upload the SRU files at skatteverket.se; nothing is sent from here).',
    pitfalls: [
      'Only for aktiebolag: another legal form answers 400 TAX_DECL_INK2_WRONG_LEGAL_FORM.',
      'Amounts are whole kronor as Skatteverket takes them; codes with no amount are 0.',
      'Run it after the year-end closing: before bokslut the tax (8910) and bokslutsdispositioner are missing, and warnings say so.',
      'A period id from another company answers 404 FISCAL_PERIOD_NOT_FOUND.',
    ],
    example: {
      request: { period_id: '7c2b…' },
      response: {
        data: {
          fiscalYear: { fiscal_period_id: '7c2b…', name: '2025', start: '2025-01-01', end: '2025-12-31', isClosed: true },
          ink2: { '7011': '20250101', '7012': '20251231', '7104': 184200, '7114': 0 },
          ink2r: { '7251': 250000, '7410': 1200000 },
          ink2s: { '7650': 146000, '7651': 38200, '7670': 184200 },
          totals: { totalAssets: 910000, totalEquityLiabilities: 910000, operatingResult: 190000, aretsResultat: 146000 },
          warnings: [],
          sru_file: { download: '/api/v1/companies/…/reports/ink2/sru?period_id=7c2b…', content_type: 'application/zip', files: ['INFO.SRU', 'BLANKETTER.SRU'] },
        },
        meta: META,
      },
    },
  },
  input: z.object({ period_id: PERIOD_ID }),
  output: z
    .object({
      fiscalYear: FiscalYear,
      ink2: Rutor,
      ink2r: Rutor,
      ink2s: Rutor,
      breakdown: Breakdown,
      totals: z.object({
        totalAssets: z.number(),
        totalEquityLiabilities: z.number(),
        operatingResult: z.number(),
        aretsResultat: z.number(),
      }),
      companyInfo: CompanyInfo,
      warnings: z.array(z.string()),
      sru_file: SruFileRef,
    })
    .loose(),
  errorCodes: ['FISCAL_PERIOD_NOT_FOUND', 'TAX_DECL_INK2_WRONG_LEGAL_FORM', 'TAX_DECL_GENERATION_FAILED'],
  http: { method: 'GET', path: '/api/v1/companies/:companyId/reports/ink2' },
  mcp: {
    name: 'gnubok_get_ink2_declaration',
    title: 'INK2 Declaration (Inkomstdeklaration 2)',
    description:
      'Aktiebolag income tax return for a räkenskapsår: INK2, INK2R (räkenskapsschema) and INK2S (skattemässiga justeringar) by SRU code, with account breakdown and warnings. The SRU files are a v1 download (sru_file.download).',
    keywords: ['ink2', 'inkomstdeklaration', 'deklaration aktiebolag', 'ink2r', 'ink2s', 'sru', 'skattemässiga justeringar'],
  },
  run: async (ctx, { period_id }) => {
    const outcome = await (await reports()).getInk2Declaration(ctx, period_id)
    if (!outcome.ok || outcome.dryRun) return asDocumented(outcome)
    return asDocumented({
      ok: true,
      data: { ...qualifyFiscalYear(outcome.data), sru_file: sruFileRef(ctx, 'ink2', period_id) },
    })
  },
})

// ─────────────────────────────────────────────────────────────────
// NE-bilaga
// ─────────────────────────────────────────────────────────────────

export const reportsNeBilaga = defineOperation({
  id: 'reports.ne-bilaga',
  kind: 'read',
  scope: 'reports:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'NE-bilaga (enskild firma): rutor R1-R11 for a räkenskapsår.',
    description:
      'Computes the NE-bilaga rutor R1-R11 from the books before the resultatavslut (försäljning, momsfria intäkter, varuinköp, övriga kostnader, lönekostnader, räntor, avskrivningar, årets resultat), with the per-ruta account breakdown and warnings. The owner\'s personnummer (the enskild firma\'s org number) is masked in this JSON; the SRU files for upload at skatteverket.se, served by GET /reports/ne-bilaga/sru, carry it in full. Read-only.',
    useWhen: 'Preparing or checking the enskild firma\'s NE-bilaga after bokslut.',
    doNotUseFor:
      'Aktiebolag (GET /reports/ink2), the egenavgifter / räntefördelning / periodiseringsfond adjustments (MCP gnubok_preview_ef_declaration), or submitting (upload the SRU files at skatteverket.se).',
    pitfalls: [
      'Only for enskild firma: another legal form answers 400 TAX_DECL_NE_WRONG_LEGAL_FORM.',
      'companyInfo.orgNumber is masked (last four digits XXXX): take the full number from the SRU file or the company settings, never from this JSON.',
      'R11 (årets resultat) is the booked result; the declaration-only adjustments (egenavgifter, räntefördelning, periodiseringsfond, expansionsfond) are not in it.',
    ],
    example: {
      request: { period_id: '7c2b…' },
      response: {
        data: {
          fiscalYear: { fiscal_period_id: '7c2b…', name: '2025', start: '2025-01-01', end: '2025-12-31', isClosed: true },
          rutor: { R1: 480000, R2: 0, R3: 0, R4: 0, R5: 120000, R6: 95000, R7: 0, R8: 0, R9: 0, R10: 12000, R11: 253000 },
          companyInfo: { companyName: 'Anna Svensson Konsult', orgNumber: '19800101-XXXX', addressLine1: null, postalCode: null, city: null, email: null },
          warnings: [],
          sru_file: { download: '/api/v1/companies/…/reports/ne-bilaga/sru?period_id=7c2b…', content_type: 'application/zip', files: ['INFO.SRU', 'BLANKETTER.SRU'] },
        },
        meta: META,
      },
    },
  },
  input: z.object({ period_id: PERIOD_ID }),
  output: z
    .object({
      fiscalYear: FiscalYear,
      rutor: z.record(z.string(), z.number()),
      breakdown: Breakdown,
      companyInfo: CompanyInfo,
      warnings: z.array(z.string()),
      sru_file: SruFileRef,
    })
    .loose(),
  errorCodes: ['FISCAL_PERIOD_NOT_FOUND', 'TAX_DECL_NE_WRONG_LEGAL_FORM', 'TAX_DECL_GENERATION_FAILED'],
  http: { method: 'GET', path: '/api/v1/companies/:companyId/reports/ne-bilaga' },
  mcp: {
    name: 'gnubok_get_ne_bilaga',
    title: 'NE-bilaga (Enskild Firma)',
    description:
      'Enskild firma NE-bilaga rutor R1-R11 for a räkenskapsår, with account breakdown and warnings. The owner\'s personnummer is masked. The SRU files are a v1 download (sru_file.download).',
    keywords: ['ne-bilaga', 'ne bilaga', 'enskild firma deklaration', 'näringsverksamhet', 'sru'],
  },
  run: async (ctx, { period_id }) => {
    const outcome = await (await reports()).getNeDeclaration(ctx, period_id)
    if (!outcome.ok || outcome.dryRun) return asDocumented(outcome)
    const declaration = outcome.data
    const pnr = declaration.companyInfo.orgNumber
    const masked = redactPersonnummer(declaration, pnr)
    return asDocumented({
      ok: true,
      data: {
        ...qualifyFiscalYear(masked),
        companyInfo: { ...masked.companyInfo, orgNumber: maskOwnerPersonnummer(pnr) },
        sru_file: sruFileRef(ctx, 'ne-bilaga', period_id),
      },
    })
  },
})

// ─────────────────────────────────────────────────────────────────
// Periodisk sammanställning
// ─────────────────────────────────────────────────────────────────

export const PsPeriodInputSchema = z
  .object({
    period_type: z.enum(['monthly', 'quarterly']).describe('monthly (varor above the threshold) or quarterly.'),
    year: z.coerce.number().int().min(2000).max(2100).describe('Calendar year, 2000-2100.'),
    period: z.coerce.number().int().min(1).max(12).describe('1-12 for monthly, 1-4 for quarterly.'),
  })
  .superRefine((data, ctx) => {
    if (data.period_type === 'quarterly' && data.period > 4) {
      ctx.addIssue({ code: 'custom', path: ['period'], message: 'For quarterly period_type, period must be 1-4.' })
    }
  })

export const reportsPeriodiskSammanstallning = defineOperation({
  id: 'reports.periodisk-sammanstallning',
  kind: 'read',
  scope: 'reports:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Periodisk sammanställning (EU sales list): per-customer EU sales of goods, services and triangulation.',
    description:
      'Builds the periodisk sammanställning for a month or quarter: one row per EU customer VAT number with varor, tjänster and trepartshandel amounts, plus warnings (missing or invalid VAT numbers, Swedish customers, credit notes), reconciled against the momsdeklaration (rutor 35, 38, 39) when the periods coincide. The SKV 574008 CSV for upload is served by GET /reports/periodisk-sammanstallning/csv. Read-only.',
    useWhen: 'Before filing the periodisk sammanställning, or checking EU sales per customer against the momsdeklaration.',
    doNotUseFor: 'The momsdeklaration itself (GET /reports/vat-declaration) or domestic sales.',
    pitfalls: [
      'Warnings with level error block the CSV download (PS_REPORT_CSV_BLOCKED_BY_ERRORS): fix them first.',
      'Amounts are whole kronor, as the CSV takes them.',
      'The CSV also needs the tax contact (name, phone, email) on the company settings.',
    ],
    example: {
      request: { period_type: 'quarterly', year: 2026, period: 2 },
      response: {
        data: {
          period: { type: 'quarterly', year: 2026, period: 2, start: '2026-04-01', end: '2026-06-30', label: 'Kvartal 2 2026' },
          rows: [
            { country: 'DE', vatNumber: '123456789', services: 42000, goods: 0, triangulation: 0, customerId: '4f1a…', customerName: 'Beispiel GmbH', hasBlockingIssue: false },
          ],
          warnings: [],
          totals: { services: 42000, goods: 0, triangulation: 0, grand: 42000, rowCount: 1 },
        },
        meta: META,
      },
    },
  },
  input: PsPeriodInputSchema,
  output: z
    .object({
      period: z.object({ type: z.string(), year: z.number(), period: z.number() }).loose(),
      rows: z.array(z.record(z.string(), z.unknown())),
      warnings: z.array(z.record(z.string(), z.unknown())),
    })
    .loose(),
  errorCodes: ['PS_REPORT_GENERATION_FAILED'],
  http: { method: 'GET', path: '/api/v1/companies/:companyId/reports/periodisk-sammanstallning' },
  mcp: {
    name: 'gnubok_get_periodisk_sammanstallning',
    title: 'Periodisk Sammanställning (EU Sales List)',
    description:
      'EU sales list for a month or quarter: per customer VAT number, varor, tjänster and trepartshandel, with blocking warnings and the reconciliation against the momsdeklaration. The SKV CSV is a v1 download.',
    keywords: ['periodisk sammanställning', 'eu-försäljning', 'eu sales list', 'skv 5740', 'omvänd skattskyldighet eu'],
  },
  run: async (ctx, input) => asDocumented(await (await reports()).getPeriodiskSammanstallning(ctx, input)),
})

// ─────────────────────────────────────────────────────────────────
// Kassaflödesanalys
// ─────────────────────────────────────────────────────────────────

export const reportsKassaflodesanalys = defineOperation({
  id: 'reports.kassaflodesanalys',
  kind: 'read',
  scope: 'reports:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Kassaflödesanalys (cash flow statement, indirect method) for a räkenskapsår.',
    description:
      'Derives the cash flow statement from the trial balance: löpande verksamhet (result after financial items, avskrivningar, changes in receivables, inventory and short-term liabilities, tax paid), investeringsverksamhet and finansieringsverksamhet, with a reconciliation of the calculated change against the actual change in cash (1xxx liquid funds). Read-only.',
    useWhen: 'Preparing the årsredovisning for a K3 company (or a larger K2 one that includes it), or analysing where the year\'s cash went.',
    doNotUseFor: 'Liquidity forecasts or bank balances (GET /reports/trial-balance for 19xx).',
    pitfalls: [
      'reconciliation.is_reconciled false means an account the analysis cannot classify moved; it does not by itself mean the books are wrong.',
      'A year whose income tax cannot be separated from other taxes answers 422 CASH_FLOW_TAX_ALLOCATION_REQUIRED.',
    ],
    example: {
      request: { period_id: '7c2b…' },
      response: {
        data: {
          fiscal_period_id: '7c2b…',
          period_start: '2025-01-01',
          period_end: '2025-12-31',
          lopande: { total: 212000 },
          investerings: { total: -45000 },
          finansierings: { total: -50000 },
          total_cash_flow: 117000,
          reconciliation: { is_reconciled: true, mismatch_amount: 0 },
        },
        meta: META,
      },
    },
  },
  input: z.object({ period_id: PERIOD_ID }),
  output: z
    .object({
      fiscal_period_id: z.string(),
      period_start: z.string(),
      period_end: z.string(),
      lopande: z.record(z.string(), z.number()),
      investerings: z.record(z.string(), z.number()),
      finansierings: z.record(z.string(), z.number()),
      total_cash_flow: z.number(),
      reconciliation: z.record(z.string(), z.union([z.number(), z.boolean()])),
    })
    .loose(),
  errorCodes: ['FISCAL_PERIOD_NOT_FOUND', 'CASH_FLOW_TAX_ALLOCATION_REQUIRED', 'REPORT_GENERATION_FAILED'],
  http: { method: 'GET', path: '/api/v1/companies/:companyId/reports/kassaflodesanalys' },
  mcp: {
    name: 'gnubok_get_cash_flow_statement',
    title: 'Cash Flow Statement (Kassaflödesanalys)',
    description:
      'Kassaflödesanalys for a räkenskapsår (indirect method): löpande, investerings- and finansieringsverksamhet, with a reconciliation against the actual change in liquid funds.',
    keywords: ['kassaflödesanalys', 'kassaflöde', 'cash flow', 'finansieringsanalys'],
  },
  run: async (ctx, { period_id }) => asDocumented(await (await reports()).getKassaflodesanalys(ctx, period_id)),
})

// ─────────────────────────────────────────────────────────────────
// Behandlingshistorik
// ─────────────────────────────────────────────────────────────────

const Company = z.object({ name: z.string(), org_number: z.string().nullable() })

export const reportsBehandlingshistorik = defineOperation({
  id: 'reports.behandlingshistorik',
  kind: 'read',
  scope: 'reports:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Behandlingshistorik (BFL 5 kap. 11 §): who changed what in the books, and when, for a räkenskapsår.',
    description:
      'The processing history the system documentation must include (BFNAR 2013:2 p. 9.16): verifikationer posted, corrected and reversed, chart of accounts and settings changes, period locks and closings, imports, access changes and program versions, each with time, actor (user, API key, MCP connection, cron) and detail lines. Filter by from_date / to_date inside the period and by one category, as the dashboard report. For an enskild firma the owner\'s personnummer is masked. Read-only.',
    useWhen: 'An auditor or Skatteverket asks how the books were processed, or you need to know who posted or changed something.',
    doNotUseFor: 'The raw row-level audit log (GET /audit-trail) or the verifikationslista (GET /reports/journal-register).',
    pitfalls: [
      'from_date and to_date must lie inside the fiscal period (400 VALIDATION_ERROR otherwise).',
      'Bursts of identical changes are collapsed into one event with count > 1.',
      'The statutory PDF, CSV and Excel exports are in the dashboard; this is the same report as JSON.',
    ],
    example: {
      request: { period_id: '7c2b…', category: 'verifikation' },
      response: {
        data: {
          company: { name: 'Testbolaget AB', org_number: '5566778899' },
          period: { fiscal_period_id: '7c2b…', name: '2026', start: '2026-01-01', end: '2026-12-31' },
          range: { from: '2026-01-01', to: '2026-12-31' },
          mode: 'fiscal_year',
          total_events: 1,
          events: [
            {
              event_id: 'entry:9a0b…',
              occurred_at: '2026-03-02T09:14:00Z',
              category: 'verifikation',
              code: 'journal_entry.committed',
              event: 'Verifikation bokförd',
              object: 'A12',
              actor: { type: 'api_key', user_id: null, label: 'Integration' },
              details: [],
              source: 'journal_entries',
              count: 1,
            },
          ],
        },
        meta: META,
      },
    },
  },
  input: z.object({
    period_id: PERIOD_ID,
    from_date: isoDateSchema.optional().describe('YYYY-MM-DD inside the period. Omit for the whole period.'),
    to_date: isoDateSchema.optional().describe('YYYY-MM-DD inside the period, not before from_date.'),
    category: z.enum(BEHANDLINGSHISTORIK_CATEGORIES).optional().describe('Only events of this category.'),
  }),
  output: z
    .object({
      company: Company,
      period: z.object({ fiscal_period_id: z.string(), name: z.string(), start: z.string(), end: z.string() }),
      range: z.object({ from: z.string(), to: z.string() }),
      mode: z.enum(['fiscal_year', 'date_range']),
      generated_at: z.string(),
      app_version: z.string().nullable(),
      total_events: z.number().int(),
      by_category: z.record(z.string(), z.number()),
      events: z.array(z.record(z.string(), z.unknown())),
    })
    .loose(),
  errorCodes: ['FISCAL_PERIOD_NOT_FOUND', 'VALIDATION_ERROR', 'REPORT_GENERATION_FAILED'],
  http: { method: 'GET', path: '/api/v1/companies/:companyId/reports/behandlingshistorik' },
  mcp: {
    name: 'gnubok_get_behandlingshistorik',
    title: 'Behandlingshistorik (Processing History)',
    description:
      'Behandlingshistorik for a räkenskapsår (BFL 5 kap. 11 §): posted, corrected and reversed verifikationer, settings and kontoplan changes, locks, imports and access, with actor and time. Filter by date range and category.',
    keywords: ['behandlingshistorik', 'ändringshistorik', 'vem bokförde', 'systemdokumentation', 'revision'],
  },
  run: async (ctx, input) => {
    const outcome = await (await reports()).getBehandlingshistorik(ctx, input)
    if (!outcome.ok || outcome.dryRun) return asDocumented(outcome)
    const report = await maskedForSoleTrader(ctx, outcome.data)
    return asDocumented({
      ok: true,
      data: { ...qualifyPeriod(report), events: report.events.map((event) => renameId(event, 'event_id')) },
    })
  },
})

// ─────────────────────────────────────────────────────────────────
// Bokslutsbilagor
// ─────────────────────────────────────────────────────────────────

export const reportsBokslutsbilagor = defineOperation({
  id: 'reports.bokslutsbilagor',
  kind: 'read',
  scope: 'reports:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Bokslutsbilagor: every balance account at the balansdag with its specification, sign-off and underlag.',
    description:
      'The bokslutsbilagor pärm for one räkenskapsår: each balance account as of the balansdag with its balance, specification or stated balance, who signed it off and when, the attached underlag files with their SHA-256, and the year-end checklist with its state. For an enskild firma the owner\'s personnummer is masked. Read-only.',
    useWhen: 'Checking which balance accounts are specified and signed off before bokslut, or handing the specification to an auditor.',
    doNotUseFor: 'The balance sheet figures alone (GET /reports/balance-sheet) or the account reconciliation work itself.',
    pitfalls: [
      'summary.unsigned counts accounts nobody has signed off; signed_other_date were signed against another date than the balansdag.',
      'The PDF of the pärm is in the dashboard; this is the same report as JSON.',
    ],
    example: {
      request: { period_id: '7c2b…' },
      response: {
        data: {
          company: { name: 'Testbolaget AB', org_number: '5566778899' },
          period: { fiscal_period_id: '7c2b…', name: '2025', start: '2025-01-01', end: '2025-12-31' },
          summary: { accounts: 14, signed_on_balansdag: 12, signed_other_date: 0, unsigned: 2, attachments: 9 },
        },
        meta: META,
      },
    },
  },
  input: z.object({ period_id: PERIOD_ID }),
  output: z
    .object({
      company: Company,
      period: z.object({ fiscal_period_id: z.string(), name: z.string(), start: z.string(), end: z.string() }),
      generated_at: z.string(),
      app_version: z.string().nullable(),
      checklist: z.object({ items: z.array(z.record(z.string(), z.unknown())), summary: z.record(z.string(), z.number()) }),
      accounts: z.array(z.record(z.string(), z.unknown())),
      summary: z.record(z.string(), z.number()),
    })
    .loose(),
  errorCodes: ['FISCAL_PERIOD_NOT_FOUND', 'REPORT_GENERATION_FAILED'],
  http: { method: 'GET', path: '/api/v1/companies/:companyId/reports/bokslutsbilagor' },
  mcp: {
    name: 'gnubok_get_bokslutsbilagor',
    title: 'Bokslutsbilagor (Balance Specifications)',
    description:
      'Bokslutsbilagor for a räkenskapsår: each balance account at the balansdag with specification, sign-off and underlag hashes, plus the year-end checklist. Use to see what is still unsigned before bokslut.',
    keywords: ['bokslutsbilagor', 'bokslutspärm', 'avstämningar', 'balansspecifikation', 'kontospecifikation'],
  },
  run: async (ctx, { period_id }) => {
    const outcome = await (await reports()).getBokslutsbilagor(ctx, period_id)
    if (!outcome.ok || outcome.dryRun) return asDocumented(outcome)
    const report = await maskedForSoleTrader(ctx, outcome.data)
    return asDocumented({
      ok: true,
      data: {
        ...qualifyPeriod(report),
        accounts: report.accounts.map((account) => ({
          ...account,
          signoff: account.signoff ? renameId(account.signoff, 'signoff_id') : null,
          attachments: account.attachments.map((attachment) => renameId(attachment, 'attachment_id')),
        })),
      },
    })
  },
})

// ─────────────────────────────────────────────────────────────────
// KPI and resultat per dimension (v1 only; MCP tools exist)
// ─────────────────────────────────────────────────────────────────

export const reportsKpi = defineOperation({
  id: 'reports.kpi',
  kind: 'read',
  scope: 'reports:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Business KPIs (nyckeltal) for a fiscal period, as the dashboard shows them.',
    description:
      'Net result, cash position, outstanding and overdue receivables, VAT liability, revenue and expenses, gross margin, expense ratio, average payment days, the monthly trend, the expense composition by BAS class 4-7, the five largest expense accounts and the largest suppliers in SEK. The company\'s KPI preferences (account overrides for cash and VAT) apply. dim_no + dim_code filter the P&L-side figures to one cost centre or project; balance-side figures stay company-wide. Read-only.',
    useWhen: 'A dashboard or monthly summary needs the same nyckeltal the Accounted overview shows.',
    doNotUseFor: 'The full income statement or balance sheet (GET /reports/income-statement, /reports/balance-sheet).',
    pitfalls: [
      'With a dimension filter, cashPosition, receivables, vatLiability and topSuppliers are still company-wide: do not present them as the dimension\'s.',
      'topSuppliersUnconvertedFxCount counts foreign-currency invoices left out of topSuppliers for lack of a SEK amount.',
      'dim_no and dim_code must be sent together.',
    ],
    example: {
      request: { period_id: '7c2b…' },
      response: {
        data: {
          netResult: 184200,
          cashPosition: 312000,
          outstandingReceivables: 45000,
          overdueReceivables: 5000,
          vatLiability: 18750,
          totalRevenue: 980000,
          totalExpenses: 795800,
          grossMargin: 0.62,
          expenseRatio: 0.81,
          avgPaymentDays: 24,
          periodComplete: false,
          period: { start: '2026-01-01', end: '2026-12-31' },
        },
        meta: META,
      },
    },
  },
  input: z
    .object({
      period_id: PERIOD_ID,
      dim_no: z.string().regex(/^[1-9]\d{0,3}$/).optional().describe('SIE dimension number, e.g. "6" projekt, "1" kostnadsställe.'),
      dim_code: z.string().min(1).optional().describe('The dimension value code, e.g. "P001". Sent with dim_no.'),
    })
    .refine((b) => (b.dim_no === undefined) === (b.dim_code === undefined), {
      message: 'dim_no and dim_code must be provided together.',
      path: ['dim_code'],
    }),
  output: z
    .object({
      netResult: z.number(),
      cashPosition: z.number(),
      outstandingReceivables: z.number(),
      overdueReceivables: z.number(),
      vatLiability: z.number(),
      totalRevenue: z.number(),
      totalExpenses: z.number(),
      grossMargin: z.number().nullable(),
      expenseRatio: z.number().nullable(),
      avgPaymentDays: z.number().nullable(),
      periodComplete: z.boolean(),
      months: z.array(z.record(z.string(), z.unknown())),
      period: z.object({ start: z.string(), end: z.string() }),
    })
    .loose(),
  errorCodes: ['FISCAL_PERIOD_NOT_FOUND', 'REPORT_GENERATION_FAILED'],
  http: { method: 'GET', path: '/api/v1/companies/:companyId/reports/kpi' },
  run: async (ctx, { period_id, dim_no, dim_code }) =>
    asDocumented(
      await (await kpi()).generateKpiReport(ctx, { period_id, dimensions: dim_no && dim_code ? { [dim_no]: dim_code } : undefined }),
    ),
})

export const reportsDimensionPnl = defineOperation({
  id: 'reports.dimension-pnl',
  kind: 'read',
  scope: 'reports:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Resultat per projekt or kostnadsställe: the income statement with one column per dimension value.',
    description:
      'A value-as-column P&L matrix over one SIE dimension (dim_no 6 projekt by default, 1 kostnadsställe, or a custom dimension): each result account\'s amount per dimension value, an "(Utan dimension)" column for untagged amounts, and a Totalt column that equals the resultatrapport. Cumulative from the period start to to_date (default the period end). Read-only.',
    useWhen: 'Following up profitability per project or cost centre.',
    doNotUseFor: 'One value only (GET /reports/income-statement with a dimension filter) or balance accounts (dimensions are P&L-side).',
    pitfalls: [
      'No from_date: the matrix uses closing-balance semantics so its Totalt reconciles with the resultatrapport.',
      'Amounts booked without a tag on the dimension land in "(Utan dimension)", not spread over the values.',
    ],
    example: {
      request: { period_id: '7c2b…', dim_no: '6' },
      response: {
        data: {
          dimension: { sie_dim_no: '6', name: 'Projekt' },
          columns: [{ code: 'P001', name: 'Projekt Alfa' }],
          net_total: 184200,
          period: { start: '2026-01-01', end: '2026-12-31' },
        },
        meta: META,
      },
    },
  },
  input: z.object({
    period_id: PERIOD_ID,
    dim_no: z.string().regex(/^[1-9]\d{0,3}$/).default('6').describe('SIE dimension number. Default "6" (projekt).'),
    to_date: isoDateSchema.optional().describe('YYYY-MM-DD inside the period. Default: the period end.'),
  }),
  output: z
    .object({
      dimension: z.object({ sie_dim_no: z.string(), name: z.string() }),
      columns: z.array(z.record(z.string(), z.unknown())),
      groups: z.array(z.record(z.string(), z.unknown())),
      net_per_column: z.array(z.number()),
      net_total: z.number(),
      period: z.object({ start: z.string(), end: z.string() }),
    })
    .loose(),
  errorCodes: ['FISCAL_PERIOD_NOT_FOUND', 'VALIDATION_ERROR', 'REPORT_GENERATION_FAILED'],
  http: { method: 'GET', path: '/api/v1/companies/:companyId/reports/dimension-pnl' },
  run: async (ctx, input) => asDocumented(await (await reports()).getDimensionPnl(ctx, input)),
})

// ─────────────────────────────────────────────────────────────────
// Audit trail (v1 only)
// ─────────────────────────────────────────────────────────────────

export const auditTrailList = defineOperation({
  id: 'audit-trail.list',
  kind: 'read',
  scope: 'reports:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'The audit log: every trigger-recorded change to the books and their settings, newest first.',
    description:
      'Rows the database triggers write on every insert, update and delete of bookkeeping tables (verifikationer and their lines, kontoplan, fiscal periods, settings, suppliers, imports, ...) and on commits, reversals, corrections and locks: action, table, record id, actor (user, API key, MCP connection, cron), description and the old and new row state. Filter by action, table_name, record_id and a created_at window. Cursor pagination: pass next_cursor back as cursor; next_cursor is null on the last page. Read-only: nothing can write the log except the triggers.',
    useWhen: 'Tracing exactly how one record changed (record_id), or exporting the raw log for an auditor.',
    doNotUseFor: 'The readable processing history for a räkenskapsår (GET /reports/behandlingshistorik).',
    pitfalls: [
      'old_state / new_state are whole row snapshots and can hold personal data (a sole trader\'s org number is the owner\'s personnummer, supplier bank details): only an owner or admin of the company receives them (snapshots_included true). Other callers get old_state/new_state null and changed_fields, the column names that changed.',
      'from_date / to_date compare against the created_at timestamp: to_date=2026-01-31 stops at 2026-01-31T00:00:00Z. Pass the next day to include all of the 31st.',
      'The page is in data.entries with data.next_cursor; a cursor that no longer decodes starts from the first page.',
    ],
    example: {
      request: { table_name: 'journal_entries', limit: 1 },
      response: {
        data: {
          entries: [
            {
              id: '0d5e…',
              action: 'COMMIT',
              table_name: 'journal_entries',
              record_id: '9a0b…',
              actor_type: 'api_key',
              actor_label: 'Integration',
              description: 'Verifikation A12 bokförd',
              old_state: null,
              new_state: { status: 'posted' },
              created_at: '2026-03-02T09:14:00Z',
            },
          ],
          next_cursor: 'eyJ0cyI6…',
        },
        meta: META,
      },
    },
  },
  input: z.object({
    action: AuditTrailQuerySchema.shape.action.describe('Only this action (INSERT, UPDATE, DELETE, COMMIT, REVERSE, CORRECT, LOCK_PERIOD, CLOSE_PERIOD, ...).'),
    table_name: z.string().min(1).optional().describe('Only rows about this table, e.g. journal_entries.'),
    record_id: z.string().min(1).optional().describe('Only rows about this record id.'),
    from_date: isoDateSchema.optional().describe('created_at on or after this date (YYYY-MM-DD).'),
    to_date: isoDateSchema.optional().describe('created_at on or before this date\'s midnight (YYYY-MM-DD).'),
    cursor: z.string().optional().describe('next_cursor from the previous page. Omit for the first page.'),
    limit: z.coerce.number().int().min(1).max(200).optional().describe('Page size, 1-200 (default 50).'),
  }),
  output: z.object({
    entries: z.array(
      z
        .object({
          id: z.string(),
          action: z.string(),
          table_name: z.string().nullable(),
          record_id: z.string().nullable(),
          user_id: z.string().nullable(),
          actor_type: z.string().nullable(),
          actor_label: z.string().nullable(),
          description: z.string().nullable(),
          old_state: z.record(z.string(), z.unknown()).nullable(),
          new_state: z.record(z.string(), z.unknown()).nullable(),
          changed_fields: z
            .array(z.string())
            .optional()
            .describe('For callers who are not owner or admin: the column names that changed, in place of the snapshots.'),
          created_at: z.string(),
        })
        .loose(),
    ),
    next_cursor: z.string().nullable(),
    snapshots_included: z
      .boolean()
      .describe('false unless the caller is an owner or admin of the company: old_state/new_state are then null.'),
  }),
  errorCodes: ['REPORT_GENERATION_FAILED'],
  http: { method: 'GET', path: '/api/v1/companies/:companyId/audit-trail' },
  run: async (ctx, input) => {
    const outcome = asDocumented(await listAuditLogPage(ctx, input))
    if (!outcome.ok || outcome.dryRun) return outcome
    // Whole row snapshots can hold personal data and bank details, and
    // reports:read is a default scope: only an owner or admin reads them over
    // the API. Everyone else sees what happened and which columns changed.
    const role = await getCompanyRole(ctx.supabase, ctx.userId, { companyId: ctx.companyId })
    const privileged = role.ok && (COMPANY_ADMIN_ROLES as readonly string[]).includes(role.role)
    const data = outcome.data as { entries: Array<Record<string, unknown>>; next_cursor: string | null }
    if (privileged) return { ok: true, data: { ...data, snapshots_included: true } }
    const entries = data.entries.map((entry) => {
      const before = (entry.old_state as Record<string, unknown> | null) ?? {}
      const after = (entry.new_state as Record<string, unknown> | null) ?? {}
      const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
        .filter((key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]))
        .sort()
      return { ...entry, old_state: null, new_state: null, changed_fields: changed }
    })
    return { ok: true, data: { entries, next_cursor: data.next_cursor, snapshots_included: false } }
  },
})
