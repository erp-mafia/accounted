import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { z } from 'zod'

/**
 * GET  /api/settings/oauth-clients: list the current user's registered
 *                                    redirect URIs.
 * POST /api/settings/oauth-clients: register a new redirect URI for use
 *                                    with the MCP OAuth flow.
 *
 * Built-in patterns (claude.ai, claude.com, localhost) bypass this table
 * entirely: registrations here are only for self-hosted custom apps.
 */

const RegistrationSchema = z.object({
  client_name: z.string().trim().min(1).max(100),
  // Reject loopback first (covers http:// too) so the user gets the helpful
  // "already allowed" message instead of being told to use https for localhost.
  // Non-loopback URIs must use https.
  redirect_uri: z
    .string()
    .url('redirect_uri must be a valid URL')
    .refine(
      (u) => !/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\]|::1)(:|\/|$)/i.test(u),
      'localhost är redan tillåtet utan registrering'
    )
    .refine((u) => u.startsWith('https://'), 'redirect_uri måste använda https://')
    .max(500),
})

export const GET = withRouteContext(
  'oauth_client.list',
  async (_request, { supabase, user }) => {
    const { data, error } = await supabase
      .from('oauth_client_registrations')
      .select('id, client_name, redirect_uri, created_at, revoked_at')
      .eq('user_id', user.id)
      .order('created_at', { ascending: false })

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ data })
  },
)

export const POST = withRouteContext(
  'oauth_client.create',
  async (request, { supabase, user }) => {
    let body: z.infer<typeof RegistrationSchema>
    try {
      const json = await request.json()
      body = RegistrationSchema.parse(json)
    } catch (err) {
      const message =
        err instanceof z.ZodError
          ? err.issues[0]?.message ?? 'Ogiltig redirect URI'
          : err instanceof SyntaxError
            ? 'Ogiltig JSON i request body'
            : 'Ogiltig redirect URI'
      return NextResponse.json({ error: message }, { status: 400 })
    }

    const { data, error } = await supabase
      .from('oauth_client_registrations')
      .insert({
        user_id: user.id,
        client_name: body.client_name,
        redirect_uri: body.redirect_uri,
      })
      .select('id, client_name, redirect_uri, created_at')
      .single()

    if (error) {
      // Unique-index violation on redirect_uri → 409
      if (error.code === '23505') {
        return NextResponse.json(
          { error: 'Den här redirect URI:n är redan registrerad.' },
          { status: 409 }
        )
      }
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ data })
  },
  { requireWrite: true },
)
