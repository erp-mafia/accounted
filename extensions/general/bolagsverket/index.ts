import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { Extension, ExtensionContext } from '@/lib/extensions/types'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createLogger } from '@/lib/logger'
import {
  BolagsverketClient,
  BolagsverketApiError,
  configFromEnv,
  isBolagsverketEnvironment,
} from './lib/client'
import {
  applyHandelse,
  BolagsverketSubmissionError,
  handleWebhook,
  normalizeOrgnr,
  submitArsredovisning,
} from './lib/submission-service'
import type { BolagsverketEnvironment, HandelseMeddelande } from './types'

/**
 * Bolagsverket integration: digital inlämning av årsredovisning.
 *
 * Generates iXBRL in core (lib/bokslut/ixbrl: works without this extension),
 * and adds the Bolagsverket leg: grunduppgifter prefill, kontrollera,
 * inlämning till eget utrymme, händelseprenumerationer + webhook receiver.
 *
 * Requires an avtal with Bolagsverket and an Expisoft/Steria
 * organisationscertifikat for acceptans/produktion (ANSLUTNINGSANVISNING
 * §5-6). The static test environment (BOLAGSVERKET_ENV=test) runs without a
 * certificate but needs a firewall opening (orgnr 1234567890/1234567891).
 *
 * Environment variables (certificate material is ENV-ONLY: see clientFor):
 * - BOLAGSVERKET_ENV          test | accept | prod (default test). Also acts
 *                             as the CEILING for the per-company `environment`
 *                             setting: members may select an environment at or
 *                             below it (test < accept < prod). Unset → ceiling
 *                             is 'test', so settings alone can never reach the
 *                             platform certificate's prod access.
 * - BOLAGSVERKET_CLIENT_CERT  PEM (or base64-PEM) organisationscertifikat
 * - BOLAGSVERKET_CLIENT_KEY   PEM (or base64-PEM) private key
 * - BOLAGSVERKET_CA           optional extra CA chain
 *
 * Self-hosted installs without a certificate can skip this extension entirely
 * and file manually with the downloaded .xhtml.
 */

/** Roles allowed to file/poll: the dispatcher itself only authenticates. */
const WRITE_ROLES = new Set(['owner', 'admin', 'member'])

const ENV_ORDER: Record<BolagsverketEnvironment, number> = { test: 0, accept: 1, prod: 2 }

/** Logger for the unauthenticated webhook path (no ExtensionContext there). */
const webhookLog = createLogger('ext:bolagsverket')

/**
 * Platform ceiling for the per-company environment setting. Operator-set
 * BOLAGSVERKET_ENV caps what tenants may select; unset/invalid → 'test'.
 */
function environmentCeiling(): BolagsverketEnvironment {
  const raw = process.env.BOLAGSVERKET_ENV
  return isBolagsverketEnvironment(raw) ? raw : 'test'
}

/**
 * Resolve the effective Bolagsverket environment for a company.
 *
 * The generic extension settings endpoint
 * (app/api/extensions/[sector]/[slug]/settings) PATCHes ONE JSON blob into
 * extension_data under extension_id 'general/bolagsverket', key 'settings':
 * not per-key rows under this extension's dispatcher id: so read that row
 * directly rather than via ctx.settings.
 *
 * Validation: the value must be one of test|accept|prod and must not exceed
 * the BOLAGSVERKET_ENV ceiling (a member with settings access must not be
 * able to point a hosted tenant at prod and ride the platform certificate).
 */
async function resolveEnvironment(ctx: ExtensionContext): Promise<BolagsverketEnvironment> {
  const { data } = await ctx.supabase
    .from('extension_data')
    .select('value')
    .eq('company_id', ctx.companyId)
    .eq('extension_id', 'general/bolagsverket')
    .eq('key', 'settings')
    .maybeSingle()
  const configured = (data?.value as { environment?: unknown } | null)?.environment
  const ceiling = environmentCeiling()
  if (configured === undefined || configured === null || configured === '') {
    return ceiling
  }
  if (!isBolagsverketEnvironment(configured)) {
    throw new BolagsverketSubmissionError(
      'BOLAGSVERKET_INVALID_ENVIRONMENT',
      `Invalid environment setting '${String(configured)}'.`,
      { configured: String(configured), allowed: ['test', 'accept', 'prod'] },
    )
  }
  if (ENV_ORDER[configured] > ENV_ORDER[ceiling]) {
    throw new BolagsverketSubmissionError(
      'BOLAGSVERKET_ENV_NOT_ALLOWED',
      `Environment setting '${configured}' exceeds the BOLAGSVERKET_ENV ceiling '${ceiling}'.`,
      { configured, ceiling },
    )
  }
  return configured
}

/**
 * Build a client for the company's resolved environment.
 *
 * SECURITY: certificate material is ENV-ONLY (BOLAGSVERKET_CLIENT_CERT/_KEY/
 * _CA). It must NEVER be read from extension settings: extension_data rows
 * are readable by every company member through the extension_data SELECT RLS
 * policy, which would hand the mTLS private key to any viewer.
 */
async function clientFor(ctx: ExtensionContext): Promise<BolagsverketClient> {
  const environment = await resolveEnvironment(ctx)
  return new BolagsverketClient(configFromEnv({ environment }))
}

async function companyOrgnr(ctx: ExtensionContext): Promise<string> {
  const { data } = await ctx.supabase
    .from('company_settings')
    .select('org_number')
    .eq('company_id', ctx.companyId)
    .maybeSingle()
  const orgNumber = (data as { org_number?: string } | null)?.org_number
  if (!orgNumber) throw new Error('Organisationsnummer saknas i företagsinställningarna.')
  return normalizeOrgnr(orgNumber)
}

/**
 * Defense-in-depth RBAC for write endpoints. The extension dispatcher only
 * authenticates and resolves a company; it does NOT check the member's role.
 * Filing an årsredovisning is a write operation: viewer members are blocked.
 * Mirrors requireAgiWriteRole in the skatteverket extension.
 *
 * Returns null on success, a 403/500 NextResponse on failure.
 */
async function requireWriteRole(ctx: ExtensionContext): Promise<NextResponse | null> {
  const { data, error } = await ctx.supabase
    .from('company_members')
    .select('role')
    .eq('company_id', ctx.companyId)
    .eq('user_id', ctx.userId)
    .maybeSingle()
  if (error) {
    return errorResponseFromCode('INTERNAL_ERROR', ctx.log, {
      requestId: ctx.requestId,
      reason: `company_members role lookup failed: ${error.message}`,
    })
  }
  if (!data?.role || !WRITE_ROLES.has(data.role as string)) {
    return errorResponseFromCode('BOLAGSVERKET_FORBIDDEN', ctx.log, {
      requestId: ctx.requestId,
    })
  }
  return null
}

function apiErrorResponse(err: unknown, ctx: ExtensionContext): NextResponse {
  if (err instanceof BolagsverketSubmissionError) {
    return errorResponseFromCode(err.code, ctx.log, {
      requestId: ctx.requestId,
      reason: err.message,
      details: err.details,
    })
  }
  if (err instanceof BolagsverketApiError) {
    return errorResponseFromCode('BOLAGSVERKET_API_ERROR', ctx.log, {
      requestId: ctx.requestId,
      reason: err.message,
      status: err.status >= 400 && err.status < 600 ? err.status : 502,
      details: { upstream_message: err.message, upstream_status: err.status },
    })
  }
  const message = err instanceof Error ? err.message : 'Okänt fel'
  return errorResponseFromCode('INTERNAL_ERROR', ctx.log, {
    requestId: ctx.requestId,
    reason: message,
    details: { message },
  })
}

const noContextResponse = () =>
  NextResponse.json({ error: { code: 'NO_CONTEXT', message: 'Saknar kontext' } }, { status: 500 })

const SubmitSchema = z.object({
  fiscal_period_id: z.string().uuid(),
  avsandare_pnr: z.string().regex(/^\d{10,12}$/, 'Personnummer anges med 10-12 siffror'),
  undertecknare: z.object({
    pnr: z.string().regex(/^\d{10,12}$/, 'Personnummer anges med 10-12 siffror'),
    fornamn: z.string().min(1).max(100),
    efternamn: z.string().min(1).max(100),
    roll: z.string().min(1).max(100),
    epost: z.string().email(),
  }),
  kvittens_epost: z.array(z.string().email()).max(5).optional(),
  utdelning: z.number().min(0).optional(),
  accepted_avtalstext_andrad: z.string().optional(),
  ignore_warnings: z.boolean().optional(),
})

const PollSchema = z.object({
  fromtidpunkt: z.string().optional(),
})

export const bolagsverketExtension: Extension = {
  id: 'bolagsverket',
  name: 'Bolagsverket: digital årsredovisning',
  version: '1.0.0',
  settingsPanel: { label: 'Bolagsverket', path: '/settings/extensions' },
  apiRoutes: [
    {
      method: 'GET',
      path: '/status',
      handler: async (_request, ctx) => {
        if (!ctx) return noContextResponse()
        try {
          const environment = await resolveEnvironment(ctx)
          const config = configFromEnv()
          return NextResponse.json({
            data: {
              environment,
              environment_ceiling: environmentCeiling(),
              // Certificate material is env-only; settings can never carry it.
              has_certificate: Boolean(config.clientCertPem && config.clientKeyPem),
            },
          })
        } catch (err) {
          return apiErrorResponse(err, ctx)
        }
      },
    },
    {
      method: 'GET',
      path: '/grunduppgifter',
      handler: async (_request, ctx) => {
        if (!ctx) return noContextResponse()
        try {
          const client = await clientFor(ctx)
          const orgnr = await companyOrgnr(ctx)
          const data = await client.getGrunduppgifter(orgnr)
          return NextResponse.json({ data })
        } catch (err) {
          return apiErrorResponse(err, ctx)
        }
      },
    },
    {
      method: 'GET',
      path: '/arendestatus',
      handler: async (_request, ctx) => {
        if (!ctx) return noContextResponse()
        try {
          const client = await clientFor(ctx)
          const orgnr = await companyOrgnr(ctx)
          const data = await client.getArendestatus(orgnr)
          return NextResponse.json({ data })
        } catch (err) {
          return apiErrorResponse(err, ctx)
        }
      },
    },
    {
      method: 'GET',
      path: '/submissions',
      handler: async (request, ctx) => {
        if (!ctx) return noContextResponse()
        const url = new URL(request.url)
        const fiscalPeriodId = url.searchParams.get('fiscal_period_id')
        let query = ctx.supabase
          .from('arsredovisning_submissions')
          .select(
            'id, fiscal_period_id, handling_typ, taxonomy_version, entry_point, environment, status, undertecknare_namn, undertecknare_epost, idnummer, sha256_checksumma, kontrollsumma, bolagsverket_url, kontrollera_utfall, error_message, uploaded_at, registered_at, created_at, updated_at',
          )
          .eq('company_id', ctx.companyId)
          .order('created_at', { ascending: false })
          .limit(50)
        if (fiscalPeriodId) query = query.eq('fiscal_period_id', fiscalPeriodId)
        const { data, error } = await query
        if (error) {
          return errorResponseFromCode('INTERNAL_ERROR', ctx.log, {
            requestId: ctx.requestId,
            reason: `submissions list failed: ${error.message}`,
          })
        }
        return NextResponse.json({ data })
      },
    },
    {
      method: 'POST',
      path: '/submissions',
      handler: async (request, ctx) => {
        if (!ctx) return noContextResponse()
        const forbidden = await requireWriteRole(ctx)
        if (forbidden) return forbidden
        let parsed: z.infer<typeof SubmitSchema>
        try {
          parsed = SubmitSchema.parse(await request.json())
        } catch (err) {
          const message =
            err instanceof z.ZodError ? err.issues.map((issue) => issue.message).join('; ') : 'Ogiltig begäran'
          return errorResponseFromCode('VALIDATION_ERROR', ctx.log, {
            requestId: ctx.requestId,
            reason: message,
            details: { message },
          })
        }
        // The webhook subscription registers this URL with Bolagsverket: a
        // missing/relative base would register a broken endpoint externally.
        const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? ''
        if (!/^https?:\/\//.test(appUrl)) {
          return errorResponseFromCode('BOLAGSVERKET_CONFIG_MISSING', ctx.log, {
            requestId: ctx.requestId,
            reason: 'NEXT_PUBLIC_APP_URL is missing or not an absolute URL',
            details: { missing: 'NEXT_PUBLIC_APP_URL' },
          })
        }
        try {
          const client = await clientFor(ctx)
          const result = await submitArsredovisning(
            { supabase: ctx.supabase, client, appUrl, log: ctx.log },
            {
              companyId: ctx.companyId,
              userId: ctx.userId,
              fiscalPeriodId: parsed.fiscal_period_id,
              avsandarePnr: parsed.avsandare_pnr,
              undertecknare: parsed.undertecknare,
              kvittensEpost: parsed.kvittens_epost,
              proposedDividend: parsed.utdelning,
              acceptedAvtalstextAndrad: parsed.accepted_avtalstext_andrad,
              ignoreWarnings: parsed.ignore_warnings,
            },
          )
          return NextResponse.json({ data: result })
        } catch (err) {
          ctx.log.error('bolagsverket submission failed', err)
          return apiErrorResponse(err, ctx)
        }
      },
    },
    {
      // Webhook receiver for händelsemeddelanden (GUIDE §5.4.5 + Appendix D).
      // skipAuth: Bolagsverket authenticates with the `auth` header we set at
      // subscription time; validated against bolagsverket_subscriptions.
      method: 'POST',
      path: '/webhook',
      skipAuth: true,
      handler: async (request) => {
        let message: HandelseMeddelande
        try {
          message = (await request.json()) as HandelseMeddelande
        } catch {
          return NextResponse.json({ ok: false, reason: 'invalid json' }, { status: 400 })
        }
        const serviceClient = createServiceClientNoCookies()
        const result = await handleWebhook(
          serviceClient,
          message,
          request.headers.get('auth'),
          webhookLog,
        )
        return NextResponse.json(result.body, { status: result.status })
      },
    },
    {
      // Polling fallback: fetch händelser kept by Bolagsverket (~1 year) in
      // case webhook deliveries were missed (GUIDE §5.4.4).
      method: 'POST',
      path: '/poll-events',
      handler: async (request, ctx) => {
        if (!ctx) return noContextResponse()
        const forbidden = await requireWriteRole(ctx)
        if (forbidden) return forbidden
        let parsed: z.infer<typeof PollSchema>
        try {
          parsed = PollSchema.parse(await request.json().catch(() => ({})))
        } catch {
          parsed = {}
        }
        try {
          const client = await clientFor(ctx)
          const orgnr = await companyOrgnr(ctx)
          const { data: sub } = await ctx.supabase
            .from('bolagsverket_subscriptions')
            .select('url')
            .eq('company_id', ctx.companyId)
            .eq('orgnr', orgnr)
            .eq('environment', client.environment)
            .maybeSingle()
          if (!sub) {
            return errorResponseFromCode('BOLAGSVERKET_NO_SUBSCRIPTION', ctx.log, {
              requestId: ctx.requestId,
            })
          }
          const svar = await client.hamtaHandelser({
            url: (sub as { url: string }).url,
            orgnr: [orgnr],
            ...(parsed.fromtidpunkt ? { fromtidpunkt: parsed.fromtidpunkt } : {}),
          })
          for (const message of svar.meddelanden) {
            await applyHandelse(ctx.supabase, message, [ctx.companyId], ctx.log)
          }
          return NextResponse.json({ data: { applied: svar.meddelanden.length } })
        } catch (err) {
          return apiErrorResponse(err, ctx)
        }
      },
    },
  ],
}

export default bolagsverketExtension
