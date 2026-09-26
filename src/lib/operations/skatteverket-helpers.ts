/**
 * Skatteverket helper operations that talk to Skatteverket but file nothing:
 * AGI pre-validation (/kontrollera, Skatteverket saves nothing) and the
 * manual skattekonto sync (fetches saldo and transactions, books nothing).
 * Core never imports the skatteverket extension; the rules are reached
 * through its registry services (lib/skatteverket/extension-actions.ts), the
 * same functions the extension's dashboard routes call.
 *
 * MCP: the huvuduppgift validation is a read tool. The individuppgift
 * validation is v1 only: its payload carries the payee's personnummer
 * (betalningsmottagarId), and an agent validates a salary run's AGI through
 * gnubok_generate_agi / gnubok_agi_submit, which build the individuppgifter
 * from the run. The sync is v1 only (an MCP write would stage an approval
 * for what is a read of Skatteverket's data; the hourly cron keeps it fresh).
 */
import { z } from 'zod'
import { AGIKontrolleraHUSchema, AGIKontrolleraIUSchema } from '@/lib/salary/agi/kontrollera-schemas'
import {
  syncSkattekontoFromSkatteverket,
  validateAgiAtSkatteverket,
  type AgiUppgift,
} from '@/lib/skatteverket/extension-actions'
import type { OperationContext, OperationOutcome } from './types'
import { defineOperation } from './types'

const META = { request_id: 'req_…', api_version: '2026-05-12' }

const KontrollStatus = z.enum(['OK', 'INFO', 'ARENDE', 'STOPP', 'AVVISANDE'])

const KontrollsvarOut = z.object({
  uppgift: z.enum(['huvuduppgift', 'individuppgift']),
  status: KontrollStatus.describe(
    'Skatteverket\'s verdict: OK, INFO (notes only), ARENDE (would open a case), STOPP or AVVISANDE (would be refused).',
  ),
  fel: z
    .array(z.object({ status: KontrollStatus, felmeddelande: z.string().nullable() }))
    .describe('Each finding with its own severity; empty when status is OK.'),
})

type KontrollsvarOutput = z.infer<typeof KontrollsvarOut>

async function validate(
  ctx: OperationContext,
  uppgift: AgiUppgift,
  payload: Record<string, unknown>,
): Promise<OperationOutcome<KontrollsvarOutput>> {
  const outcome = await validateAgiAtSkatteverket(ctx, uppgift, payload)
  if (!outcome.ok || outcome.dryRun) return outcome
  return {
    ok: true,
    data: {
      uppgift,
      status: outcome.data.status,
      fel: outcome.data.fel.map((f) => ({ status: f.status, felmeddelande: f.felmeddelande ?? null })),
    },
  }
}

const SKV_ERROR_CODES = [
  'EXTENSION_DISABLED',
  'SKATTEVERKET_CAPABILITY_BLOCKED',
  'SKATTEVERKET_NOT_CONNECTED',
  'SKATTEVERKET_ACCESS_DENIED',
  'SKATTEVERKET_RATE_LIMITED',
  'SKATTEVERKET_API_ERROR',
]

const CONNECTION_PITFALL =
  'Needs a live Skatteverket connection: 401 SKATTEVERKET_NOT_CONNECTED when the company has none or it expired (personal BankID sessions last about 1 hour by design). Only a person can reconnect; do not retry until they confirm.'

const EXAMPLE_KONTROLLSVAR = {
  status: 'INFO',
  fel: [{ status: 'INFO', felmeddelande: 'Summa skatteavdrag är 0.' }],
}

export const skatteverketAgiValidateHuvuduppgift = defineOperation({
  id: 'skatteverket.agi-validate-huvuduppgift',
  kind: 'read',
  scope: 'compliance:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Pre-validate an AGI huvuduppgift at Skatteverket without filing anything.',
    description:
      'Sends one arbetsgivardeklaration huvuduppgift (AGI API v1.7 section 7: agRegistreradId, redovisningsPeriod, the totals) to Skatteverket\'s /kontrollera and answers its kontrollsvar: an overall status and each finding. Skatteverket saves nothing; the only local write is the regulator audit row. Uses the calling user\'s own Skatteverket connection. Live call, not cached.',
    useWhen: 'Checking a hand-built or externally generated huvuduppgift before filing it, e.g. from a payroll system outside Accounted.',
    doNotUseFor:
      'Filing (POST /salary-runs/{id}/generate-agi, then the BankID-signed submission) or checking a salary run booked in Accounted (the submission flow validates it).',
    pitfalls: [
      CONNECTION_PITFALL,
      'redovisningsPeriod is YYYYMM and no earlier than 201807; amounts are whole kronor.',
      'A payload that breaks the v1.7 schema answers 400 VALIDATION_ERROR before anything reaches Skatteverket.',
      'status OK or INFO means Skatteverket would accept the figures; it never checks them against the books.',
    ],
    example: {
      request: { agRegistreradId: '165560000167', redovisningsPeriod: '202609', summaSkatteavdr: 0 },
      response: { data: { uppgift: 'huvuduppgift', ...EXAMPLE_KONTROLLSVAR }, meta: META },
    },
  },
  input: AGIKontrolleraHUSchema,
  output: KontrollsvarOut,
  errorCodes: SKV_ERROR_CODES,
  http: { method: 'POST', path: '/api/v1/companies/:companyId/skatteverket/agi/validate-huvuduppgift' },
  mcp: {
    name: 'gnubok_agi_validate_huvuduppgift',
    title: 'Validate AGI Huvuduppgift',
    description:
      'Pre-validate one AGI huvuduppgift (employer totals for a month) at Skatteverket /kontrollera. Files nothing; answers the kontrollsvar status and findings. Needs a live Skatteverket connection.',
    keywords: ['arbetsgivardeklaration', 'agi', 'huvuduppgift', 'kontrollera agi', 'förhandsgranska agi'],
  },
  run: (ctx, input) => validate(ctx, 'huvuduppgift', input as Record<string, unknown>),
})

export const skatteverketAgiValidateIndividuppgift = defineOperation({
  id: 'skatteverket.agi-validate-individuppgift',
  kind: 'read',
  scope: 'compliance:read',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Pre-validate one AGI individuppgift at Skatteverket without filing anything.',
    description:
      'Sends one individuppgift (AGI API v1.7 section 8: the payee, specifikationsnummer, cash pay, benefits, preliminary tax and flags) to Skatteverket\'s /kontrollera and answers its kontrollsvar. Skatteverket saves nothing; the only local write is the regulator audit row. Uses the calling user\'s own Skatteverket connection. Live call, not cached.',
    useWhen: 'Checking a hand-built or externally generated individuppgift before filing it.',
    doNotUseFor:
      'Filing, or salary runs booked in Accounted (the AGI submission flow builds and validates their individuppgifter).',
    pitfalls: [
      CONNECTION_PITFALL,
      'betalningsmottagarId is the payee\'s personnummer (12 digits): it is sent to Skatteverket and not stored by Accounted beyond the audit row\'s metadata.',
      'forstaAnstalld and vaxaStod are mutually exclusive (400 VALIDATION_ERROR).',
      'A payload that breaks the v1.7 schema answers 400 VALIDATION_ERROR before anything reaches Skatteverket.',
    ],
    example: {
      request: {
        agRegistreradId: '165560000167',
        redovisningsPeriod: '202609',
        betalningsmottagarId: '19800101XXXX',
        specifikationsnummer: 1,
        kontantErsattningUlagAG: 35000,
        avdrPrelSkatt: 8200,
      },
      response: { data: { uppgift: 'individuppgift', status: 'OK', fel: [] }, meta: META },
    },
  },
  input: AGIKontrolleraIUSchema,
  output: KontrollsvarOut,
  errorCodes: SKV_ERROR_CODES,
  http: { method: 'POST', path: '/api/v1/companies/:companyId/skatteverket/agi/validate-individuppgift' },
  run: (ctx, input) => validate(ctx, 'individuppgift', input as Record<string, unknown>),
})

export const skattekontoSync = defineOperation({
  id: 'skattekonto.sync',
  kind: 'write',
  scope: 'transactions:write',
  risk: 'low',
  reversible: false,
  docs: {
    summary: 'Fetch the skattekonto from Skatteverket now instead of waiting for the hourly sync.',
    description:
      'Reads the company\'s skattekonto saldo and transactions (booked and upcoming) from Skatteverket and stores them, then refreshes the booking proposals and the reconciliation snapshot. Books nothing: booking skattekonto rows is a separate step. Read-only on Skatteverket\'s side. Runs on the company\'s connection (any member\'s BankID connection, or a verified läsombud grant). Idempotent. Dry-runnable: the dry run checks the connection locally and never calls Skatteverket.',
    useWhen: 'A payment to or from the skattekonto was just made and the reconciliation or the booking proposals should see it now.',
    doNotUseFor: 'Booking skattekonto rows, or importing a skattekonto file (POST /imports/skattekonto-file).',
    pitfalls: [
      CONNECTION_PITFALL,
      'The paid Skatteverket capability is required: 403 SKATTEVERKET_CAPABILITY_BLOCKED otherwise.',
      'Skatteverket only returns roughly the last 555 days; older history comes from a skattekonto file import.',
    ],
    example: {
      response: {
        data: { booked: 3, upcoming: 1, skipped: 0, saldo_skatteverket: -1240, saldo_kronofogden: 0, synced_at: '2026-09-26T08:00:00.000Z' },
        meta: META,
      },
    },
  },
  input: z.object({}),
  output: z.object({
    booked: z.number().int().describe('New or status-promoted booked rows.'),
    upcoming: z.number().int().describe('New or updated upcoming rows.'),
    skipped: z.number().int().describe('Rows dropped because Skatteverket omitted a required field.'),
    saldo_skatteverket: z.number().describe('Balance at Skatteverket after the sync (negative = debt).'),
    saldo_kronofogden: z.number(),
    synced_at: z.string(),
  }),
  errorCodes: SKV_ERROR_CODES,
  http: { method: 'POST', path: '/api/v1/companies/:companyId/skattekonto/sync' },
  run: async (ctx, _input, { dryRun }) => {
    const outcome = await syncSkattekontoFromSkatteverket(ctx, { dryRun })
    if (!outcome.ok || outcome.dryRun) return outcome
    const r = outcome.data
    return {
      ok: true,
      data: {
        booked: r.booked,
        upcoming: r.upcoming,
        skipped: r.skipped,
        saldo_skatteverket: r.saldoSkatteverket,
        saldo_kronofogden: r.saldoKronofogden,
        synced_at: r.syncedAt,
      },
    }
  },
})
