import { NextResponse } from 'next/server'
import type { Extension } from '@/lib/extensions/types'
import { registerMailSearchService } from '@/lib/mail-search/service'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { GmailSearchService } from './lib/search-service'
import { getMailboxAddress } from './lib/gmail-client'
import { createOAuthState, verifyOAuthState } from './lib/crypto'
import {
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  getGoogleOAuthEnv,
  isGoogleMailConfigured,
} from './lib/google-oauth'
import { disconnect, listConnections, saveConnection } from './lib/connections'
import { resolveCallbackOrigin } from './lib/callback-origin'
import { isMailConnectEnabled } from './lib/connect-gate'
import { requireFlowInitiator } from '@/lib/auth/oauth-flow-binding'

// Registered as soon as the extension loads, so the receipt hunt can search
// mail without core ever importing from @/extensions.
registerMailSearchService(new GmailSearchService())

function jsonError(message: string, status = 500): Response {
  return NextResponse.json({ error: message }, { status })
}

/** How far back a newly connected mailbox may be searched, in days. */
const BACKFILL_CHOICES = new Set([30, 90, 365])

export const mailExtension: Extension = {
  id: 'mail',
  name: 'Brevlådor',
  version: '0.1.0',
  sector: 'general',

  settingsPanel: {
    label: 'Brevlådor',
    path: '/settings/mail',
  },

  apiRoutes: [
    // Start the consent flow. Returns the URL rather than redirecting so the
    // caller can open it in a deliberate, user-gesture tab.
    {
      method: 'POST',
      path: '/oauth/start',
      handler: async (request, ctx) => {
        if (!ctx) return jsonError('Missing context', 500)
        if (!isGoogleMailConfigured()) return jsonError('provider_not_configured', 400)
        // Withheld while Google's scope review is open; see connect-gate.ts.
        if (!isMailConnectEnabled(ctx.companyId)) return jsonError('connect_disabled', 403)
        try {
          const url = new URL(request.url)
          const origin = resolveCallbackOrigin(url.origin)
          const state = createOAuthState(ctx.userId, ctx.companyId)
          const env = getGoogleOAuthEnv(origin)
          return NextResponse.json({ url: buildAuthorizationUrl(env, state) })
        } catch (err) {
          ctx.log.error('mail oauth start failed', err)
          return jsonError(err instanceof Error ? err.message : 'Could not start OAuth', 500)
        }
      },
    },

    // Google redirects here after consent. Registered in the Google console as
    // an authorised redirect URI: the `mail` slug and this path are pinned and
    // must never be renamed without re-registering.
    {
      method: 'GET',
      path: '/oauth/callback',
      skipAuth: true,
      handler: async (request) => {
        const url = new URL(request.url)
        const code = url.searchParams.get('code')
        const state = url.searchParams.get('state')
        const error = url.searchParams.get('error')
        const settingsUrl = `${resolveCallbackOrigin(url.origin)}/settings/mail`

        // The user declining is a normal outcome, not an error to shout about.
        if (error) return NextResponse.redirect(`${settingsUrl}?mail=denied`)
        if (!code || !state) return NextResponse.redirect(`${settingsUrl}?mail=invalid`)

        const verified = verifyOAuthState(state)
        if (!verified) return NextResponse.redirect(`${settingsUrl}?mail=expired`)

        // The signed state proves the flow was started by verified.userId for
        // verified.companyId; it does not prove that the browser now finishing
        // it is that user. The grant is written for the state's user and
        // company with the service client, so without this check a victim
        // lured into approving a Google consent someone else started would
        // have THEIR mailbox attached to that someone's company. Checked
        // before the code exchange so a refused flow burns nothing.
        const initiator = await requireFlowInitiator(request, verified.userId, {
          flow: 'mail.oauth-callback',
        })
        if (!initiator.ok) {
          // No session: sign in and the callback re-runs with the same code
          // and state (the state is stateless and still within its TTL).
          if (initiator.reason === 'no_session') return initiator.response
          return NextResponse.redirect(`${settingsUrl}?mail=mismatch`)
        }

        try {
          const origin = resolveCallbackOrigin(url.origin)
          const env = getGoogleOAuthEnv(origin)
          const tokens = await exchangeCodeForTokens(env, code)
          if (!tokens.refreshToken) {
            return NextResponse.redirect(`${settingsUrl}?mail=no_refresh_token`)
          }
          // The address comes from Gmail's profile endpoint rather than an
          // id_token, so the consent screen asks for gmail.readonly alone.
          const email = await getMailboxAddress(tokens.accessToken)
          if (!email) {
            // Without the address we cannot tell two grants apart, and the
            // unique key depends on it.
            return NextResponse.redirect(`${settingsUrl}?mail=no_address`)
          }

          await saveConnection(createServiceClientNoCookies(), {
            companyId: verified.companyId,
            userId: verified.userId,
            provider: 'gmail',
            emailAddress: email,
            refreshToken: tokens.refreshToken,
            accessToken: tokens.accessToken,
            expiresAt: tokens.expiresAt,
            scopes: tokens.scopes,
            backfillFrom: null,
          })
          return NextResponse.redirect(`${settingsUrl}?mail=connected`)
        } catch {
          return NextResponse.redirect(`${settingsUrl}?mail=failed`)
        }
      },
    },

    // What this company has connected. Safe projection only: never tokens.
    {
      method: 'GET',
      path: '/connections',
      handler: async (_request, ctx) => {
        if (!ctx) return jsonError('Missing context', 500)
        const connections = await listConnections(createServiceClientNoCookies(), ctx.companyId)
        return NextResponse.json({
          data: {
            connections,
            configured: isGoogleMailConfigured(),
            // Whether this company may start a NEW consent right now. Listing
            // and disconnecting existing mailboxes never depend on it.
            connectEnabled: isMailConnectEnabled(ctx.companyId),
          },
        })
      },
    },

    {
      method: 'DELETE',
      path: '/connections',
      handler: async (request, ctx) => {
        if (!ctx) return jsonError('Missing context', 500)
        const id = new URL(request.url).searchParams.get('id')
        if (!id) return jsonError('missing_id', 400)
        await disconnect(createServiceClientNoCookies(), ctx.companyId, id, ctx.userId)
        return NextResponse.json({ data: { disconnected: true } })
      },
    },

    // How far back a mailbox may be searched once, chosen by the user at
    // connect time. Bounded to the offered choices so an arbitrary date cannot
    // widen the grant's reach by hand.
    {
      method: 'POST',
      path: '/connections/backfill',
      handler: async (request, ctx) => {
        if (!ctx) return jsonError('Missing context', 500)
        const body = (await request.json().catch(() => ({}))) as { id?: string; days?: number }
        if (!body.id || !body.days || !BACKFILL_CHOICES.has(body.days)) {
          return jsonError('invalid_request', 400)
        }
        const from = new Date()
        from.setDate(from.getDate() - body.days)
        const supabase = createServiceClientNoCookies()
        await supabase
          .from('mail_connections')
          .update({ backfill_from: from.toISOString().slice(0, 10) })
          .eq('id', body.id)
          .eq('company_id', ctx.companyId)
        return NextResponse.json({ data: { backfill_from: from.toISOString().slice(0, 10) } })
      },
    },
  ],
}
