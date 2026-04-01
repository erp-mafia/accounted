import crypto from 'crypto'
import type { Extension, ExtensionContext } from '@/lib/extensions/types'
import { NextResponse } from 'next/server'
import { buildAuthorizeUrl, exchangeCodeForTokens } from './lib/oauth'
import { storeTokens, getTokens, deleteTokens } from './lib/token-store'
import { skvRequest, SkatteverketAuthError } from './lib/api-client'
import { rutorToMomsuppgift, formatRedovisare, formatRedovisningsperiod } from './lib/mappers'
import { calculateVatDeclaration } from '@/lib/reports/vat-declaration'
import type { VatPeriodType } from '@/types'

/**
 * Skatteverket integration extension.
 *
 * Enables filing momsdeklaration (VAT declaration) directly to Skatteverket
 * via their Momsdeklaration API 1.0. Users authenticate with BankID through
 * the `per` (e-legitimation) OAuth2 flow.
 *
 * Required environment variables:
 * - SKATTEVERKET_OAUTH2_CLIENT_ID
 * - SKATTEVERKET_OAUTH2_CLIENT_SECRET
 * - SKATTEVERKET_APIGW_CLIENT_ID
 * - SKATTEVERKET_APIGW_CLIENT_SECRET
 * - SKATTEVERKET_TOKEN_ENCRYPTION_KEY
 *
 * Optional:
 * - SKATTEVERKET_OAUTH_BASE_URL (defaults to test environment)
 * - SKATTEVERKET_API_BASE_URL (defaults to test environment)
 */
export const skatteverketExtension: Extension = {
  id: 'skatteverket',
  name: 'Skatteverket Integration',
  version: '1.0.0',

  settingsPanel: {
    label: 'Skatteverket',
    path: '/settings/account',
  },

  apiRoutes: [
    // ── OAuth: Start authorization ──────────────────────────────────
    // Builds the Skatteverket OAuth2 authorize URL and redirects the user
    // to BankID login. Stores state token in extension settings for CSRF validation.
    {
      method: 'GET',
      path: '/authorize',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }

        const state = crypto.randomUUID()
        const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
        const redirectUri = `${appUrl}/api/extensions/ext/skatteverket/callback`

        // Store state for CSRF validation in callback
        await ctx.settings.set('oauth_state', state)
        await ctx.settings.set('oauth_redirect_uri', redirectUri)

        const authorizeUrl = buildAuthorizeUrl(redirectUri, state)

        return NextResponse.redirect(authorizeUrl)
      },
    },

    // ── OAuth: Callback ─────────────────────────────────────────────
    // Receives the auth code from Skatteverket after BankID login.
    // Exchanges code for tokens immediately (5-minute code expiry).
    // skipAuth: true — browser redirect from Skatteverket. We handle
    // user identification via the stored state token + Supabase session.
    {
      method: 'GET',
      path: '/callback',
      skipAuth: true,
      handler: async (request: Request) => {
        const appUrl = process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000'
        const url = new URL(request.url)
        const code = url.searchParams.get('code')
        const state = url.searchParams.get('state')
        const error = url.searchParams.get('error')

        if (error) {
          const desc = url.searchParams.get('error_description') || 'Okänt fel'
          return NextResponse.redirect(
            `${appUrl}/reports?tab=vat-declaration&skv_error=${encodeURIComponent(desc)}`
          )
        }

        if (!code || !state) {
          return NextResponse.redirect(
            `${appUrl}/reports?tab=vat-declaration&skv_error=${encodeURIComponent('Saknar auktoriseringskod')}`
          )
        }

        // Exchange code FIRST — 5-minute expiry, do this before anything else
        const { createClient } = await import('@/lib/supabase/server')
        const supabase = await createClient()

        // Verify user session (browser should still have cookies)
        const { data: { user } } = await supabase.auth.getUser()
        if (!user) {
          return NextResponse.redirect(
            `${appUrl}/login?redirect=${encodeURIComponent('/reports?tab=vat-declaration')}`
          )
        }

        // Validate CSRF state
        const { data: settingsData } = await supabase
          .from('extension_data')
          .select('value')
          .eq('company_id', user.id)
          .eq('extension_id', 'skatteverket')
          .eq('key', 'oauth_state')
          .single()

        if (!settingsData || settingsData.value !== state) {
          return NextResponse.redirect(
            `${appUrl}/reports?tab=vat-declaration&skv_error=${encodeURIComponent('Ogiltig state-parameter (CSRF)')}`
          )
        }

        // Get the stored redirect URI
        const { data: redirectData } = await supabase
          .from('extension_data')
          .select('value')
          .eq('company_id', user.id)
          .eq('extension_id', 'skatteverket')
          .eq('key', 'oauth_redirect_uri')
          .single()

        const redirectUri = redirectData?.value ||
          `${appUrl}/api/extensions/ext/skatteverket/callback`

        try {
          const tokens = await exchangeCodeForTokens(code, redirectUri)
          await storeTokens(supabase, user.id, tokens)

          // Clean up CSRF state
          await supabase
            .from('extension_data')
            .delete()
            .eq('company_id', user.id)
            .eq('extension_id', 'skatteverket')
            .eq('key', 'oauth_state')

          return NextResponse.redirect(
            `${appUrl}/reports?tab=vat-declaration&skv_connected=true`
          )
        } catch (err) {
          console.error('[skatteverket] Token exchange failed:', err)
          return NextResponse.redirect(
            `${appUrl}/reports?tab=vat-declaration&skv_error=${encodeURIComponent(
              err instanceof Error ? err.message : 'Token exchange misslyckades'
            )}`
          )
        }
      },
    },

    // ── Connection status ───────────────────────────────────────────
    {
      method: 'GET',
      path: '/status',
      handler: async (_request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }

        const tokens = await getTokens(ctx.supabase, ctx.companyId)
        if (!tokens) {
          return NextResponse.json({ connected: false })
        }

        const expired = tokens.expires_at < Date.now()
        const canRefresh = tokens.refresh_token !== null && tokens.refresh_count < 10

        return NextResponse.json({
          connected: true,
          expired,
          canRefresh,
          scope: tokens.scope,
          expiresAt: new Date(tokens.expires_at).toISOString(),
        })
      },
    },

    // ── Disconnect ──────────────────────────────────────────────────
    {
      method: 'POST',
      path: '/disconnect',
      handler: async (_request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }

        await deleteTokens(ctx.supabase, ctx.companyId)
        return NextResponse.json({ success: true })
      },
    },

    // ── Validate declaration (dry run) ──────────────────────────────
    // Sends momsuppgift to Skatteverket's /kontrollera endpoint.
    // Returns ERROR/WARNING/OK without saving anything.
    {
      method: 'POST',
      path: '/declaration/validate',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }

        try {
          const { redovisare, redovisningsperiod, momsuppgift } =
            await parseDeclarationRequest(request, ctx)

          console.log('[skatteverket] Validating:', {
            redovisare,
            redovisningsperiod,
            momsuppgift: JSON.stringify(momsuppgift),
          })

          const response = await skvRequest(
            ctx.supabase,
            ctx.companyId,
            'POST',
            `/kontrollera/${redovisare}/${redovisningsperiod}`,
            momsuppgift
          )

          if (!response.ok) {
            const text = await response.text()
            console.error('[skatteverket] Validate error:', response.status, text)
            return NextResponse.json(
              { error: `Skatteverket svarade med ${response.status}: ${text}` },
              { status: response.status }
            )
          }

          const data = await response.json()
          return NextResponse.json({ data })
        } catch (err) {
          return handleSkvError(err)
        }
      },
    },

    // ── Save draft ──────────────────────────────────────────────────
    // Saves momsuppgift to Skatteverket's "Eget utrymme".
    // Returns validation results. Optionally lock for signing.
    {
      method: 'POST',
      path: '/declaration/draft',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }

        try {
          const { redovisare, redovisningsperiod, momsuppgift } =
            await parseDeclarationRequest(request, ctx)

          console.log('[skatteverket] Sending draft:', {
            redovisare,
            redovisningsperiod,
            momsuppgift: JSON.stringify(momsuppgift),
          })

          const response = await skvRequest(
            ctx.supabase,
            ctx.companyId,
            'POST',
            `/utkast/${redovisare}/${redovisningsperiod}`,
            momsuppgift
          )

          if (!response.ok) {
            const text = await response.text()
            console.error('[skatteverket] Draft error:', response.status, text)
            return NextResponse.json(
              { error: `Skatteverket svarade med ${response.status}: ${text}` },
              { status: response.status }
            )
          }

          const data = await response.json()

          // Track submission status
          await ctx.settings.set(
            `submission_${redovisningsperiod}`,
            JSON.stringify({
              status: 'draft_saved',
              redovisare,
              redovisningsperiod,
              kontrollresultat: data.kontrollresultat,
              updatedAt: new Date().toISOString(),
            })
          )

          return NextResponse.json({ data })
        } catch (err) {
          return handleSkvError(err)
        }
      },
    },

    // ── Fetch draft ─────────────────────────────────────────────────
    {
      method: 'GET',
      path: '/declaration/draft',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }

        try {
          const { redovisare, redovisningsperiod } = parseQueryParams(request, ctx)

          const response = await skvRequest(
            ctx.supabase,
            ctx.companyId,
            'GET',
            `/utkast/${redovisare}/${redovisningsperiod}`
          )

          if (response.status === 404) {
            return NextResponse.json({ data: null })
          }

          if (!response.ok) {
            const text = await response.text()
            return NextResponse.json(
              { error: `Skatteverket svarade med ${response.status}: ${text}` },
              { status: response.status }
            )
          }

          const data = await response.json()
          return NextResponse.json({ data })
        } catch (err) {
          return handleSkvError(err)
        }
      },
    },

    // ── Delete draft ────────────────────────────────────────────────
    {
      method: 'DELETE',
      path: '/declaration/draft',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }

        try {
          const { redovisare, redovisningsperiod } = parseQueryParams(request, ctx)

          const response = await skvRequest(
            ctx.supabase,
            ctx.companyId,
            'DELETE',
            `/utkast/${redovisare}/${redovisningsperiod}`
          )

          if (response.status !== 204 && !response.ok) {
            const text = await response.text()
            return NextResponse.json(
              { error: `Skatteverket svarade med ${response.status}: ${text}` },
              { status: response.status }
            )
          }

          await ctx.settings.set(`submission_${redovisningsperiod}`, null)
          return NextResponse.json({ success: true })
        } catch (err) {
          return handleSkvError(err)
        }
      },
    },

    // ── Lock draft for signing ──────────────────────────────────────
    // Returns a signeringslänk (deep link) that the user opens
    // in a new tab to sign with BankID on Skatteverket's site.
    {
      method: 'PUT',
      path: '/declaration/lock',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }

        try {
          const { redovisare, redovisningsperiod } = parseQueryParams(request, ctx)

          const response = await skvRequest(
            ctx.supabase,
            ctx.companyId,
            'PUT',
            `/las/${redovisare}/${redovisningsperiod}`
          )

          if (!response.ok) {
            const text = await response.text()
            return NextResponse.json(
              { error: `Skatteverket svarade med ${response.status}: ${text}` },
              { status: response.status }
            )
          }

          const data = await response.json()

          await ctx.settings.set(
            `submission_${redovisningsperiod}`,
            JSON.stringify({
              status: 'draft_locked',
              redovisare,
              redovisningsperiod,
              signeringslank: data.signeringslank,
              updatedAt: new Date().toISOString(),
            })
          )

          return NextResponse.json({ data })
        } catch (err) {
          return handleSkvError(err)
        }
      },
    },

    // ── Unlock draft ────────────────────────────────────────────────
    {
      method: 'DELETE',
      path: '/declaration/lock',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }

        try {
          const { redovisare, redovisningsperiod } = parseQueryParams(request, ctx)

          const response = await skvRequest(
            ctx.supabase,
            ctx.companyId,
            'DELETE',
            `/las/${redovisare}/${redovisningsperiod}`
          )

          if (response.status !== 204 && !response.ok) {
            const text = await response.text()
            return NextResponse.json(
              { error: `Skatteverket svarade med ${response.status}: ${text}` },
              { status: response.status }
            )
          }

          await ctx.settings.set(
            `submission_${redovisningsperiod}`,
            JSON.stringify({
              status: 'draft_saved',
              redovisare,
              redovisningsperiod,
              updatedAt: new Date().toISOString(),
            })
          )

          return NextResponse.json({ success: true })
        } catch (err) {
          return handleSkvError(err)
        }
      },
    },

    // ── Fetch submitted declaration ─────────────────────────────────
    {
      method: 'GET',
      path: '/declaration/submitted',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }

        try {
          const { redovisare, redovisningsperiod } = parseQueryParams(request, ctx)

          const response = await skvRequest(
            ctx.supabase,
            ctx.companyId,
            'GET',
            `/inlamnat/${redovisare}/${redovisningsperiod}`
          )

          if (response.status === 404) {
            return NextResponse.json({ data: null })
          }

          if (!response.ok) {
            const text = await response.text()
            return NextResponse.json(
              { error: `Skatteverket svarade med ${response.status}: ${text}` },
              { status: response.status }
            )
          }

          const data = await response.json()
          return NextResponse.json({ data })
        } catch (err) {
          return handleSkvError(err)
        }
      },
    },

    // ── Fetch decided declaration ───────────────────────────────────
    {
      method: 'GET',
      path: '/declaration/decided',
      handler: async (request: Request, ctx?: ExtensionContext) => {
        if (!ctx) {
          return NextResponse.json({ error: 'Extension context required' }, { status: 500 })
        }

        try {
          const { redovisare, redovisningsperiod } = parseQueryParams(request, ctx)

          const response = await skvRequest(
            ctx.supabase,
            ctx.companyId,
            'GET',
            `/beslutat/${redovisare}/${redovisningsperiod}`
          )

          if (response.status === 404) {
            return NextResponse.json({ data: null })
          }

          if (!response.ok) {
            const text = await response.text()
            return NextResponse.json(
              { error: `Skatteverket svarade med ${response.status}: ${text}` },
              { status: response.status }
            )
          }

          const data = await response.json()
          return NextResponse.json({ data })
        } catch (err) {
          return handleSkvError(err)
        }
      },
    },
  ],
}

// ── Helpers ───────────────────────────────────────────────────────────

/**
 * Parse and validate declaration request body.
 * Computes momsuppgift from gnubok's VAT calculation if not provided directly.
 */
async function parseDeclarationRequest(
  request: Request,
  ctx: ExtensionContext
): Promise<{
  redovisare: string
  redovisningsperiod: string
  momsuppgift: ReturnType<typeof rutorToMomsuppgift>
}> {
  const body = await request.json()
  const { periodType, year, period } = body as {
    periodType: VatPeriodType
    year: number
    period: number
  }

  if (!periodType || !year || !period) {
    throw new Error('Saknar obligatoriska fält: periodType, year, period')
  }

  // Get company settings for redovisare formatting
  const { data: settings } = await ctx.supabase
    .from('company_settings')
    .select('org_number, entity_type')
    .eq('company_id', ctx.companyId)
    .single()

  if (!settings?.org_number) {
    throw new Error('Organisationsnummer saknas i företagsinställningar')
  }

  const redovisare = formatRedovisare(settings.org_number, settings.entity_type)
  const redovisningsperiod = formatRedovisningsperiod(periodType, year, period)

  // Calculate VAT declaration from the general ledger
  const declaration = await calculateVatDeclaration(
    ctx.supabase,
    ctx.companyId,
    periodType,
    year,
    period
  )

  const momsuppgift = rutorToMomsuppgift(declaration.rutor)

  return { redovisare, redovisningsperiod, momsuppgift }
}

/**
 * Parse redovisare and redovisningsperiod from query params.
 * Used by GET/PUT/DELETE endpoints that don't need a full body.
 */
function parseQueryParams(
  request: Request,
  ctx: ExtensionContext
): { redovisare: string; redovisningsperiod: string } {
  const url = new URL(request.url)
  const redovisare = url.searchParams.get('redovisare')
  const redovisningsperiod = url.searchParams.get('redovisningsperiod')

  if (!redovisare || !redovisningsperiod) {
    throw new Error('Saknar obligatoriska parametrar: redovisare, redovisningsperiod')
  }

  // Suppress unused variable warning — ctx is required by the type signature
  void ctx

  return { redovisare, redovisningsperiod }
}

/**
 * Convert Skatteverket errors to appropriate HTTP responses.
 */
function handleSkvError(err: unknown): NextResponse {
  if (err instanceof SkatteverketAuthError) {
    const status = err.code === 'NOT_CONNECTED' ? 401
      : err.code === 'BEHORIGHET_SAKNAS' ? 403
      : err.code === 'SESSION_EXPIRED' || err.code === 'REFRESH_EXHAUSTED' ? 401
      : 403

    return NextResponse.json(
      { error: err.message, code: err.code },
      { status }
    )
  }

  console.error('[skatteverket] API error:', err)
  return NextResponse.json(
    { error: err instanceof Error ? err.message : 'Okänt fel' },
    { status: 500 }
  )
}
