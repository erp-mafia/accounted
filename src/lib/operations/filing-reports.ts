/**
 * Filing and year-end report reads that neither v1 nor MCP served before:
 * INK2, NE-bilaga, the INK3 underlag, periodisk sammanställning, kassaflödesanalys,
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
import { accountNumberSchema, isoDateSchema } from '@/lib/invariants/zod'
import { BUDGET_EXAMPLE_ACCOUNTS, RESULTATKONTO_FIRST, RESULTATKONTO_LAST } from '@/lib/bookkeeping/bas-data/result-accounts'
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
  entityType: z.string().describe('The legal form: what decides the 12-digit identity on the SRU files.'),
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
      'Computes the aktiebolag income tax return from the books, keyed by SRU field code: ink2 (page 1: 7104 överskott / 7114 underskott, 7132/7133 underlag för särskild löneskatt på pensionskostnader from 7410-7419), ink2r (räkenskapsschema: balance sheet and income statement, the balance sheet from the closed books and the income statement before the resultatavslut) and ink2s (skattemässiga justeringar, including the adjustments saved in the year-end flow), with the per-code account breakdown, totals and warnings. The SRU files for upload at skatteverket.se are served by GET /reports/ink2/sru; sru_file names that path. Read-only.',
    useWhen:
      'Preparing or checking the aktiebolag income tax return after bokslut, or reconciling INK2R figures against the årsredovisning.',
    doNotUseFor:
      'Enskild firma (GET /reports/ne-bilaga), the årsredovisning itself, or submitting to Skatteverket (upload the SRU files at skatteverket.se; nothing is sent from here).',
    pitfalls: [
      'Only for aktiebolag: another legal form answers 400 TAX_DECL_INK2_WRONG_LEGAL_FORM.',
      'Amounts are whole kronor as Skatteverket takes them; codes with no amount are 0.',
      'Run it after the year-end closing: before bokslut the tax (8910) and bokslutsdispositioner are missing, and warnings say so.',
      'ink2s is not the whole INK2S. Computed: 7650/7750 (4.1/4.2), 7651 (4.3a), 7652 (4.3b, write-downs of financial assets), 7653 (4.3c), 7753 (4.5b, dividends) and 7754 (4.5c) from the year-end adjustments, 7673 (4.6d, the 6 % or 4 % uppräkning on periodiseringsfonder set aside before 2021 and återförda this year, oldest first; 0 with a warning when a fond names no year or its year cannot be told), 7654 (4.6a, schablonintäkt on the opening periodiseringsfonder: statslåneräntan of 30 November the year before the calendar year the räkenskapsår ends in, at least 0.5 %, times whole months / 12, so brutet, short and long years are covered; a year that starts or ends mid-month, or whose rate is not published yet, gets 0 with a warning naming the opening fonder), 7666/7765 (4.9), 7763 (4.14a) and 7670/7770 (4.15/4.16). 7763 is the deficit saved in the year-end flow or the underskottsregister, never read from last year\'s return: 0 means none was entered, not that none exists. Every other INK2S row and the upplysningar about the årsredovisning (8040/8041 uppdragstagare, 8044/8045 revision) are neither computed nor in the SRU file; they are entered in Skatteverket\'s e-tjänst.',
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
    summary: 'NE-bilaga (enskild firma): balansräkning B1-B16 and rutor R1-R11 for a räkenskapsår.',
    description:
      'Computes the NE-bilaga rutor R1-R11 from the books before the resultatavslut (försäljning, momsfria intäkter, varuinköp, övriga kostnader, lönekostnader, räntor, avskrivningar, årets resultat) and the balansräkning B1-B16 at the year\'s end (balans, per BAS kopplingstabell NE_EJ_K1; B10 eget kapital is tillgångar minus skulder), with the per-ruta account breakdown and warnings. The owner\'s personnummer (the enskild firma\'s org number) is masked in this JSON; the SRU files, served by GET /reports/ne-bilaga/sru, carry it in full and hold B1-B16, R1-R11 and sida 2 R12-R14 (R13 and R14 are the tax adjustments, as in sida2). Read-only.',
    useWhen: 'Preparing or checking the enskild firma\'s NE-bilaga after bokslut.',
    doNotUseFor:
      'Aktiebolag (GET /reports/ink2), the egenavgifter / räntefördelning / periodiseringsfond adjustments (MCP gnubok_preview_ef_declaration), or submitting (the owner imports blanketter.sru in Skatteverket\'s Inkomstdeklaration 1 e-tjänst, Bilagor, Enskild näringsverksamhet (NE), and completes sida 2 there).',
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
          balans: { B4: 36000, B7: 40000, B9: 210000, B10: 238000, B16: 48000 },
          companyInfo: { companyName: 'Anna Svensson Konsult', orgNumber: '19800101-XXXX', entityType: 'enskild_firma', addressLine1: null, postalCode: null, city: null, email: null },
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
      balans: z.record(z.string(), z.number()),
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
      'Enskild firma NE-bilaga for a räkenskapsår: balansräkning B1-B16 and rutor R1-R11, with account breakdown and warnings. The owner\'s personnummer is masked. The SRU files are a v1 download (sru_file.download).',
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
// INK3 underlag (ideell förening)
// ─────────────────────────────────────────────────────────────────

const Ink3AccountLineSchema = z.object({
  accountNumber: z.string(),
  accountName: z.string(),
  amount: z.number(),
  treatment: z.enum(['exempt', 'taxable', 'shared']).nullable(),
})

const Ink3FieldSchema = z.object({
  code: z.string().describe('SRU field code, e.g. 8651.'),
  blankett: z.enum(['INK3R', 'INK3S', 'INK3SUF']),
  ruta: z.string().nullable().describe('The printed row, e.g. 6.2; null for an unnumbered box.'),
  label: z.string().describe("Skatteverket's label, in Swedish."),
  column: z
    .enum(['bokforing', 'skattepliktig'])
    .nullable()
    .describe('INK3R income statement: bokforing = enligt redovisningen, skattepliktig = som ska tas upp/dras av.'),
  sign: z.enum(['+', '-', '*']).nullable(),
  datatyp: z.string(),
  value: z
    .union([z.number(), z.boolean(), z.string()])
    .nullable()
    .describe('What to type in: whole kronor, a ticked box, or text. The override when there is one.'),
  computed: z.number().nullable().describe('What the books or the arithmetic give before any override.'),
  source: z.enum(['books', 'computed', 'input', 'override']),
  overridable: z.boolean(),
  needsInput: z.boolean().describe("True when the ruta waits for the user's figure (a shared or unclassified account)."),
  needsInputReason: z.enum(['shared_account', 'unclassified_account', 'not_computable']).nullable(),
  accounts: z.array(Ink3AccountLineSchema),
})

export const reportsInk3 = defineOperation({
  id: 'reports.ink3',
  kind: 'read',
  scope: 'reports:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'INK3 underlag (ideell förening): INK3R, INK3S and INK3SUF values per ruta for a räkenskapsår.',
    description:
      "The figures an ideell förening types into Skatteverket's e-tjänst Inkomstdeklaration 2, 3 och 4, by field code: INK3R (balance sheet from the closed books; income statement in two columns, enligt redovisningen from the books before the resultatavslut and som ska tas upp/dras av from the company's per-account treatment), INK3S (7.1/7.2, 7.5a and 7.9/7.10 computed, the rest entered) and INK3SUF (entered; part of filing only when the company states the förening is allmännyttig). Overrides the company saved replace the computed figure. filing holds every field with a value. Field codes from Skatteverket's 2026P4 edition, which covers beskattningsperiod 2026P4 to 2027P3. Read-only: nothing is filed and no SRU file exists; the user signs the first page in the e-tjänst.",
    useWhen: "Preparing or checking an ideell förening's INK3 after bokslut, or answering what goes in a ruta.",
    doNotUseFor:
      'Aktiebolag or ekonomisk förening (GET /reports/ink2), enskild firma (GET /reports/ne-bilaga), deciding whether the förening is allmännyttig (the company states it), or submitting anything to Skatteverket.',
    pitfalls: [
      'Only for ideell förening: another legal form answers 400 TAX_DECL_INK3_WRONG_LEGAL_FORM.',
      'Only räkenskapsår in a covered beskattningsperiod (2026P4 to 2027P3: ending 2026-09-01 to 2027-08-31); others answer 422 TAX_DECL_INK3_PERIOD_NOT_SUPPORTED.',
      'A field with needsInput true has no final figure yet: a shared or unclassified account feeds it. The treatments and overrides are set in the app, not over v1 or MCP.',
      'allmannyttig null means the company has not stated it; INK3SUF is left out of filing until it says yes.',
      'Amounts are whole kronor with öre dropped.',
    ],
    example: {
      request: { period_id: '7c2b…' },
      response: {
        data: {
          fiscalYear: { fiscal_period_id: '7c2b…', name: '2026', start: '2026-01-01', end: '2026-12-31', isClosed: true },
          beskattningsperiod: '2026P4',
          allmannyttig: true,
          sufApplicable: true,
          filing: { '8650': 42000, '8653': 120000, '8673': 120000, '8663': 18000, '8685': 9000, '8686': 9000, '8695': 9000, '8822': 'X' },
          totals: { totalAssets: 310000, totalEquityLiabilities: 310000, bookkeepingResult: 18000, taxableResult: 9000, taxableSurplus: 9000 },
          complete: true,
          warnings: [],
        },
        meta: META,
      },
    },
  },
  input: z.object({ period_id: PERIOD_ID }),
  output: z
    .object({
      fiscalYear: FiscalYear,
      beskattningsperiod: z.string(),
      fieldTable: z.object({ beskattningsperiod: z.string(), files: z.array(z.string()) }),
      companyInfo: z.object({ companyName: z.string(), orgNumber: z.string().nullable() }),
      allmannyttig: z.boolean().nullable(),
      sufApplicable: z.boolean(),
      fields: z.array(Ink3FieldSchema),
      filing: z.record(z.string(), z.union([z.number(), z.string()])),
      accounts: z.array(
        z.object({
          accountNumber: z.string(),
          accountName: z.string(),
          ruta: z.string(),
          amount: z.number(),
          treatment: z.enum(['exempt', 'taxable', 'shared']).nullable(),
        }),
      ),
      totals: z.object({
        totalAssets: z.number(),
        totalEquityLiabilities: z.number(),
        bookkeepingResult: z.number(),
        taxableResult: z.number(),
        taxableSurplus: z.number(),
      }),
      complete: z.boolean(),
      warnings: z.array(z.string()),
    })
    .loose(),
  errorCodes: [
    'FISCAL_PERIOD_NOT_FOUND',
    'TAX_DECL_INK3_WRONG_LEGAL_FORM',
    'TAX_DECL_INK3_PERIOD_NOT_SUPPORTED',
    'TAX_DECL_GENERATION_FAILED',
  ],
  http: { method: 'GET', path: '/api/v1/companies/:companyId/reports/ink3' },
  mcp: {
    name: 'gnubok_get_ink3_underlag',
    title: 'INK3 Underlag (Inkomstdeklaration 3, ideell förening)',
    description:
      "Ideell förening INK3 underlag for a räkenskapsår: INK3R (both columns), INK3S and INK3SUF by field code, to type into Skatteverket's e-tjänst. Read-only; nothing is filed. Rutor with needsInput wait for the user's figure.",
    keywords: ['ink3', 'inkomstdeklaration 3', 'ideell förening', 'förening deklaration', 'ink3r', 'ink3s', 'ink3suf', 'särskild uppgift'],
  },
  run: async (ctx, { period_id }) => {
    const outcome = await (await reports()).getInk3Underlag(ctx, period_id)
    if (!outcome.ok || outcome.dryRun) return asDocumented(outcome)
    return asDocumented({ ok: true, data: qualifyFiscalYear(outcome.data) })
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
      'Builds the periodisk sammanställning for a month or quarter: one row per EU customer VAT number with varor, tjänster and trepartshandel amounts, plus warnings (missing or invalid VAT numbers, Swedish customers, credit notes), reconciled against the momsdeklaration (rutor 35, 38, 39) for the same dates. The SKV 574008 CSV for upload is served by GET /reports/periodisk-sammanstallning/csv. Read-only.',
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
      'Derives the cash flow statement from the trial balance, with every account in exactly one line: löpande verksamhet (result after financial items, avskrivningar and other non-cash items, changes in receivables, inventory and short-term liabilities, tax paid, koncernbidrag), investeringsverksamhet (acquisitions, disposals at their proceeds, kortfristiga placeringar) and finansieringsverksamhet, reconciled against the actual change in cash (19xx). `statement` holds the same year laid out to K3 chapter 7 (from rörelseresultat; interest and dividends received and paid as separate cash lines; investments per kind and loans gross; the exchange difference on likvida medel apart) with the previous year as `statement.previous`. Bokslut entries are included, only the resultatavslut is left out. Read-only.',
    useWhen: 'Preparing the årsredovisning for a K3 company (or a larger K2 one that includes it), or analysing where the year\'s cash went.',
    doNotUseFor: 'Liquidity forecasts or bank balances (GET /reports/trial-balance for 19xx).',
    pitfalls: [
      'lopande.ovriga_poster is the change on accounts outside every BAS range the analysis classifies, named in unclassified_accounts. reconciliation.is_reconciled false means the period\'s postings do not balance.',
      'A year whose income tax cannot be separated from other taxes answers 422 CASH_FLOW_TAX_ALLOCATION_REQUIRED.',
      'statement.current.amounts is keyed by line (rorelseresultat, erlagd_ranta, upptagna_lan, ...); statement.previous is null when there is no earlier year with activity, and statement.previous_status says why.',
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
          unclassified_accounts: [],
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
      unclassified_accounts: z.array(z.string()),
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
      'The processing history the system documentation must include (BFNAR 2013:2 p. 9.16): verifikationer posted, corrected and reversed, chart of accounts and settings changes, period locks and closings, imports, access changes and program versions, and decisions on bank lines and underlag (category beslut: the suggestions on offer, the one booked, who decided and which agent proposed it), each with time, actor (user, API key, MCP connection, cron) and detail lines. Filter by from_date / to_date inside the period and by one category, as the dashboard report. For an enskild firma the owner\'s personnummer is masked. Read-only.',
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
// KPI and resultat per dimension (v1 only; MCP tools exist), and resultat
// across two dimensions (v1 and search-only MCP tools)
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
      'vatLiability is the moms on the 26xx accounts that no momsredovisning has moved to 2650 or 1650 yet, not ruta 49: moms a booked momsredovisning moved is no longer in it. The declared figure is the vat_payable measure.',
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
      'A value-as-column P&L matrix over one SIE dimension (dim_no 6 projekt by default, 1 kostnadsställe, or a custom dimension): each result account\'s amount per dimension value, an "(Utan dimension)" column for untagged amounts, and a Totalt column that equals the resultatrapport for the same window. The window is from_date to to_date (defaults: the period start and end), so one quarter per project is one call. Read-only.',
    useWhen: 'Following up profitability per project or cost centre, for the year or for one quarter or month.',
    doNotUseFor: 'One value only (GET /reports/income-statement with dim_no and dim_code) or balance accounts (dimensions are P&L-side).',
    pitfalls: [
      'from_date and to_date must lie inside the period. Amounts are the activity inside that window, not balances accumulated from the period start.',
      'Amounts booked without a tag on the dimension land in "(Utan dimension)", not spread over the values.',
      'What the bokslut run posts (source year_end: tax, bokslut depreciation, dispositions, resultatavslut) is left out, tagged or not, exactly as in the resultatrapport.',
    ],
    example: {
      request: { period_id: '7c2b…', dim_no: '6', from_date: '2026-07-01', to_date: '2026-09-30' },
      response: {
        data: {
          dimension: { sie_dim_no: '6', name: 'Projekt' },
          columns: [{ code: 'P001', name: 'Projekt Alfa' }],
          net_total: 184200,
          period: { start: '2026-07-01', end: '2026-09-30' },
        },
        meta: META,
      },
    },
  },
  input: z.object({
    period_id: PERIOD_ID,
    dim_no: z.string().regex(/^[1-9]\d{0,3}$/).default('6').describe('SIE dimension number. Default "6" (projekt).'),
    from_date: isoDateSchema.optional().describe('YYYY-MM-DD inside the period. Default: the period start.'),
    to_date: isoDateSchema.optional().describe('YYYY-MM-DD inside the period, not before from_date. Default: the period end.'),
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

// Resultat across two dimensions (accounted#133). Search-only MCP tools: an
// agent reaches them through gnubok_search_tools at no cost to tools/list.
const DIM_NO = z.string().regex(/^[1-9]\d{0,3}$/)
const RESULT_ACCOUNT = accountNumberSchema

const dimensionCrossAxes = {
  period_id: PERIOD_ID,
  dim_a: DIM_NO.describe('The row dimension, an SIE dimension number: "1" kostnadsställe, "6" projekt, or a custom one.'),
  dim_b: DIM_NO.describe('The column dimension, a different SIE dimension number.'),
  account_from: RESULT_ACCOUNT.optional().describe('First account of the measure, 3000-8999, sent with account_to. Default: the whole result.'),
  account_to: RESULT_ACCOUNT.optional().describe('Last account of the measure (inclusive), 3000-8999.'),
  from_date: isoDateSchema.optional().describe('YYYY-MM-DD inside the period. Default: the period start.'),
  to_date: isoDateSchema.optional().describe('YYYY-MM-DD inside the period, not before from_date. Default: the period end.'),
}

type AxesInput = { dim_a: string; dim_b: string; account_from?: string; account_to?: string }
const twoDimensions = (b: AxesInput) => b.dim_a !== b.dim_b
const rangeTogether = (b: AxesInput) => (b.account_from === undefined) === (b.account_to === undefined)

const DIMENSION_CROSS_PITFALLS = [
  'dim_a and dim_b must be two different dimensions; both are tags on the same line. A property of a dimension value (a home\'s region kept on the home) is not a tag and is not read.',
  'Amounts are credit minus debit, as in the resultatrapport: revenue positive, costs negative.',
  'Lines without a tag on a dimension land in its "(Utan dimension)" row or column (code null); the untagged x untagged cell is the remainder of the resultatrapport, so the cells sum to total.',
  'What the bokslut run posts (source year_end) and the IB verifikat are left out, as in the resultatrapport.',
]

export const reportsDimensionCross = defineOperation({
  id: 'reports.dimension-cross',
  kind: 'read',
  scope: 'reports:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Result across two dimensions: one dimension\'s values as rows, another\'s as columns, one amount per cell.',
    description:
      'A matrix over two SIE dimensions tagged on the same journal lines: rows are dim_a\'s values, columns dim_b\'s, each cell the result (or the accounts account_from to account_to) of the lines carrying both tags, with row and column totals. "(Utan dimension)" rows and columns (code null) hold the lines without that tag, and total equals the resultatrapport for the same window and accounts. Read the lines behind a cell with GET /reports/dimension-cross/lines. Read-only.',
    useWhen: 'Following up result per region and channel, per project and cost centre, or any two dimensions the books tag, for the year or one quarter or month.',
    doNotUseFor: 'One dimension (GET /reports/dimension-pnl, accounts as rows) or one value only (GET /reports/income-statement with dim_no and dim_code).',
    pitfalls: DIMENSION_CROSS_PITFALLS,
    example: {
      request: { period_id: '7c2b…', dim_a: '1', dim_b: '6' },
      response: {
        data: {
          dim_a: { sie_dim_no: '1', name: 'Kostnadsställe' },
          dim_b: { sie_dim_no: '6', name: 'Projekt' },
          accounts: { from: RESULTATKONTO_FIRST, to: RESULTATKONTO_LAST },
          rows: [{ code: 'NORR', name: 'Region Norr' }, { code: null, name: null }],
          columns: [{ code: 'WEB', name: 'Webb' }, { code: null, name: null }],
          cells: [[120000, 15000], [0, -40000]],
          row_totals: [135000, -40000],
          column_totals: [120000, -25000],
          total: 95000,
          period: { start: '2026-01-01', end: '2026-12-31' },
        },
        meta: META,
      },
    },
  },
  input: z.object(dimensionCrossAxes)
    .refine(twoDimensions, { message: 'dim_a and dim_b must be two different dimensions.', path: ['dim_b'] })
    .refine(rangeTogether, { message: 'account_from and account_to must be sent together.', path: ['account_to'] }),
  output: z
    .object({
      dim_a: z.object({ sie_dim_no: z.string(), name: z.string() }),
      dim_b: z.object({ sie_dim_no: z.string(), name: z.string() }),
      accounts: z.object({ from: z.string(), to: z.string() }),
      rows: z.array(z.object({ code: z.string().nullable(), name: z.string().nullable() })),
      columns: z.array(z.object({ code: z.string().nullable(), name: z.string().nullable() })),
      cells: z.array(z.array(z.number())),
      row_totals: z.array(z.number()),
      column_totals: z.array(z.number()),
      total: z.number(),
      period: z.object({ start: z.string(), end: z.string() }),
    })
    .loose(),
  errorCodes: ['FISCAL_PERIOD_NOT_FOUND', 'VALIDATION_ERROR', 'REPORT_NOT_READY', 'REPORT_GENERATION_FAILED'],
  http: { method: 'GET', path: '/api/v1/companies/:companyId/reports/dimension-cross' },
  mcp: {
    name: 'gnubok_get_dimension_cross',
    title: 'Result Across Two Dimensions',
    description:
      'Result per value of one dimension (rows) and another (columns) tagged on the same lines, e.g. region x channel or project x cost centre, with totals equal to the resultatrapport. Optional account range and date window.',
    keywords: ['två dimensioner', 'korstabell', 'pivot', 'resultat per region och kanal', 'projekt och kostnadsställe', 'dimensioner', 'cross tab', 'matrix'],
  },
  run: async (ctx, input) => asDocumented(await (await reports()).getDimensionCross(ctx, input)),
})

export const reportsDimensionCrossLines = defineOperation({
  id: 'reports.dimension-cross-lines',
  kind: 'read',
  scope: 'reports:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'The journal lines behind one cell of the two-dimension result, a page at a time.',
    description:
      'The lines one cell of GET /reports/dimension-cross sums: same period, window, accounts and entry set, the lines whose dim_a tag is code_a and dim_b tag is code_b (codes compared trimmed; leave a code out for the "(Utan dimension)" row or column). In date and voucher order, at most limit (default 200, at most 1000); pass next.after_date, next.after_voucher and next.after_line back for the next page. Each line names its verifikat (journal_entry_id, voucher_series, voucher_number). Read-only.',
    useWhen: 'Checking what makes up one cell of the two-dimension report.',
    doNotUseFor: 'All lines of an account (GET /reports/general-ledger).',
    pitfalls: [
      'Send the same dim_a, dim_b, account range and window as the report, or the lines will not add up to the cell.',
      'A code left out means "no tag on that dimension", not "any value".',
    ],
    example: {
      request: { period_id: '7c2b…', dim_a: '1', code_a: 'NORR', dim_b: '6', code_b: 'WEB', limit: 1 },
      response: {
        data: {
          lines: [
            {
              line_id: '5d1e…',
              journal_entry_id: '9a0b…',
              entry_date: '2026-03-02',
              voucher_series: 'A',
              voucher_number: 12,
              description: 'Bokning 1042',
              line_description: null,
              account_number: BUDGET_EXAMPLE_ACCOUNTS.sales,
              debit_amount: 0,
              credit_amount: 4800,
              dimensions: { '1': 'NORR', '6': 'WEB' },
            },
          ],
          has_more: true,
          next: { after_date: '2026-03-02', after_voucher: 12, after_line: '5d1e…' },
        },
        meta: META,
      },
    },
  },
  input: z
    .object({
      ...dimensionCrossAxes,
      code_a: z.string().min(1).optional().describe('The value of dim_a; leave out for the "(Utan dimension)" row.'),
      code_b: z.string().min(1).optional().describe('The value of dim_b; leave out for the "(Utan dimension)" column.'),
      after_date: isoDateSchema.optional().describe('next.after_date from the previous page.'),
      after_voucher: z.coerce.number().int().min(0).optional().describe('next.after_voucher from the previous page.'),
      after_line: z.string().uuid().optional().describe('next.after_line from the previous page.'),
      limit: z.coerce.number().int().min(1).max(1000).optional().describe('Page size, 1-1000 (default 200).'),
    })
    .refine(twoDimensions, { message: 'dim_a and dim_b must be two different dimensions.', path: ['dim_b'] })
    .refine(rangeTogether, { message: 'account_from and account_to must be sent together.', path: ['account_to'] }),
  output: z
    .object({
      lines: z.array(z.record(z.string(), z.unknown())),
      has_more: z.boolean(),
      next: z.object({ after_date: z.string(), after_voucher: z.number(), after_line: z.string() }).nullable(),
    })
    .loose(),
  errorCodes: ['FISCAL_PERIOD_NOT_FOUND', 'VALIDATION_ERROR', 'REPORT_NOT_READY', 'REPORT_GENERATION_FAILED'],
  http: { method: 'GET', path: '/api/v1/companies/:companyId/reports/dimension-cross/lines' },
  mcp: {
    name: 'gnubok_get_dimension_cross_lines',
    title: 'Two-Dimension Result Lines',
    description:
      'The journal lines behind one cell of gnubok_get_dimension_cross (code_a, code_b; leave one out for its untagged row or column), paged, each with its verifikat.',
    keywords: ['två dimensioner', 'verifikat bakom', 'rader', 'drill-down', 'korstabell'],
  },
  run: async (ctx, input) => asDocumented(await (await reports()).getDimensionCrossLines(ctx, input)),
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
