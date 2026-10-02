import { NextResponse } from 'next/server'
import { z } from 'zod'
import type { Extension, ExtensionContext } from '@/lib/extensions/types'
import { isCompanyAdmin, requireWritePermission } from '@/lib/auth/require-write'
import { registerMailSearchService } from '@/lib/mail-search/service'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'
import { createLogger } from '@/lib/logger'
import { GmailSearchService } from './lib/search-service'
import { getMailboxAddress } from './lib/gmail-client'
import { createOAuthFlow, verifyOAuthState } from './lib/crypto'
import {
  buildAuthorizationUrl,
  exchangeCodeForTokens,
  getGoogleOAuthEnv,
  isGoogleMailConfigured,
  lacksGmailScope,
  revokeGoogleToken,
} from './lib/google-oauth'
import {
  SCOPE_MISSING,
  disconnect,
  findConnectionOwner,
  listConnections,
  saveConnection,
} from './lib/connections'
import { resolveCallbackOrigin } from './lib/callback-origin'
import { isMailConnectEnabled } from './lib/connect-gate'
import { requireFlowInitiator } from '@/lib/auth/oauth-flow-binding'
import { createClient } from '@/lib/supabase/server'

// Registered as soon as the extension loads, so the receipt hunt can search
// mail without core ever importing from @/extensions.
registerMailSearchService(new GmailSearchService())

const log = createLogger('mail-extension')

function jsonError(message: string, status = 500): Response {
  return NextResponse.json({ error: message }, { status })
}

/**
 * Connecting a mailbox changes what feeds underlag into the books, so a
 * viewer (read-only member) may not. The dispatcher only proves a session;
 * the role is checked here, the same rule withRouteContext's requireWrite
 * applies to the app's own routes. Disconnecting has its own rule
 * (DELETE /connections).
 */
async function refuseViewer(ctx: ExtensionContext): Promise<Response | null> {
  const check = await requireWritePermission(ctx.supabase, ctx.userId, { companyId: ctx.companyId })
  return check.ok ? null : check.response
}

/**
 * The start route's checks, repeated when Google redirects back: the connect
 * gate, the company being visible to the person (RLS hides an archived one),
 * and their role in it. Read through their own session, like the start.
 */
async function mayStillConnect(userId: string, companyId: string): Promise<boolean> {
  if (!isMailConnectEnabled(companyId)) return false
  const supabase = await createClient()
  const { data: company } = await supabase.from('companies').select('id').eq('id', companyId).maybeSingle()
  if (!company) return false
  const writer = await requireWritePermission(supabase, userId, { companyId })
  if (!writer.ok) log.warn('mail consent completed by someone who may no longer connect', { companyId })
  return writer.ok
}

const ConnectionId = z.string().uuid()

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
        const refused = await refuseViewer(ctx)
        if (refused) return refused
        if (!isGoogleMailConfigured()) return jsonError('provider_not_configured', 400)
        // Withheld while Google's scope review is open; see connect-gate.ts.
        if (!isMailConnectEnabled(ctx.companyId)) return jsonError('connect_disabled', 403)
        try {
          const url = new URL(request.url)
          const origin = resolveCallbackOrigin(url.origin)
          const { state, codeChallenge } = createOAuthFlow(ctx.userId, ctx.companyId)
          const env = getGoogleOAuthEnv(origin)
          return NextResponse.json({ url: buildAuthorizationUrl(env, state, codeChallenge) })
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

        // Up to ten minutes pass between the start and this redirect, and the
        // grant is saved on the service role, so what the start route checked
        // is checked again for the company in the state: still open for new
        // consents, still a company this person can see (an archived one is
        // hidden by RLS), and still one they may write to.
        if (!(await mayStillConnect(verified.userId, verified.companyId))) {
          return NextResponse.redirect(`${settingsUrl}?mail=failed`)
        }

        try {
          const origin = resolveCallbackOrigin(url.origin)
          const env = getGoogleOAuthEnv(origin)
          const tokens = await exchangeCodeForTokens(env, code, verified.codeVerifier)
          // What Google granted decides, not what was asked for. Its consent
          // screen lets a person untick Gmail and still approve, and such a
          // grant used to be saved as an active mailbox that failed every
          // search, while this callback reported something unrelated because
          // the profile call below needs the scope too. Nothing is saved, and
          // the unused grant is revoked so it does not linger in the person's
          // Google account.
          if (lacksGmailScope(tokens.scopes)) {
            const revocation = await revokeGoogleToken(tokens.refreshToken ?? tokens.accessToken)
            log.info('refused a mail grant without the gmail scope', {
              revocation: revocation.outcome,
              status: revocation.status,
            })
            return NextResponse.redirect(`${settingsUrl}?mail=${SCOPE_MISSING}`)
          }
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
        // A malformed id would otherwise reach the database as a cast error
        // and come back as a 500.
        if (!ConnectionId.safeParse(id).success) return jsonError('invalid_id', 400)
        const supabase = createServiceClientNoCookies()
        const connection = await findConnectionOwner(supabase, ctx.companyId, id)
        if (!connection) return jsonError('not_found', 404)
        // Disconnecting only ever reduces access, so the person whose grant
        // it is may always do it, whatever their role now. Anyone else needs
        // to run the company: a colleague's mailbox is not a plain member's
        // to cut off.
        if (connection.connectedBy !== ctx.userId && !(await isCompanyAdmin(ctx.supabase, ctx.companyId))) {
          return jsonError('disconnect_not_allowed', 403)
        }
        await disconnect(supabase, ctx.companyId, id, ctx.userId)
        return NextResponse.json({ data: { disconnected: true } })
      },
    },
  ],
}
