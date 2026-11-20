import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { createServiceClient } from '@/lib/supabase/server'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

// Only the two content toggles are user-settable. Strict: the previous
// implementation passed the raw JSON body into .update(), which would have
// let a caller set feed_token (token fixation on a public URL), expires_at,
// or access_count.
const UpdateFeedSchema = z
  .object({
    include_tax_deadlines: z.boolean().optional(),
    include_invoices: z.boolean().optional(),
  })
  .strict()
  .refine(
    (v) => v.include_tax_deadlines !== undefined || v.include_invoices !== undefined,
    { message: 'Nothing to update' },
  )

function feedUrls(feedToken: string) {
  // Fail closed in production: an http:// fallback would mint a link that
  // carries the feed's bearer token over an unencrypted channel.
  const envUrl = process.env.NEXT_PUBLIC_APP_URL
  if (!envUrl && process.env.NODE_ENV === 'production') {
    throw new Error('NEXT_PUBLIC_APP_URL must be set in production')
  }
  const baseUrl = envUrl || 'http://localhost:3000'
  return {
    webcalUrl: `webcal://${baseUrl.replace(/^https?:\/\//, '')}/api/calendar/feed/${feedToken}`,
    httpsUrl: `${baseUrl}/api/calendar/feed/${feedToken}`,
  }
}

// Every column except feed_token. The token is the feed's bearer credential
// and is withheld from end-user roles by a column grant, so the session
// client reads these columns and the route adds the token itself.
const FEED_COLUMNS =
  'id, user_id, company_id, is_active, include_tax_deadlines, include_invoices, last_accessed_at, access_count, created_at, updated_at, expires_at'

/**
 * The feed's token, read on the service role. Callers pass a feed the
 * session client already returned for the caller's active company, so the
 * membership check has happened; the company filter keeps the read in it.
 */
async function readFeedToken(companyId: string, feedId: string): Promise<string> {
  const { data, error } = await createServiceClient()
    .from('calendar_feeds')
    .select('feed_token')
    .eq('id', feedId)
    .eq('company_id', companyId)
    .single()
  if (error || !data) {
    throw new Error(`calendar feed token read failed: ${error?.message ?? 'no row'}`)
  }
  return data.feed_token as string
}

function withFeedUrls<T extends object>(feed: T, feedToken: string) {
  return { ...feed, feed_token: feedToken, ...feedUrls(feedToken) }
}

/**
 * GET /api/calendar/feed
 * Get current user's calendar feed settings
 */
export const GET = withRouteContext('calendar_feed.get', async (_request, ctx) => {
  const { supabase, companyId } = ctx

  const { data: feed, error } = await supabase
    .from('calendar_feeds')
    .select(FEED_COLUMNS)
    .eq('company_id', companyId)
    .single()

  if (error && error.code !== 'PGRST116') {
    // PGRST116 = no rows returned, which is fine
    return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })
  }

  if (feed) {
    const feedToken = await readFeedToken(companyId, feed.id)
    return NextResponse.json({ data: withFeedUrls(feed, feedToken) })
  }

  return NextResponse.json({ data: null })
})

/**
 * POST /api/calendar/feed
 * Create a new calendar feed for the current user
 */
export const POST = withRouteContext(
  'calendar_feed.create',
  async (_request, ctx) => {
    const { supabase, companyId, user } = ctx

    // Check if feed already exists
    const { data: existingFeed } = await supabase
      .from('calendar_feeds')
      .select('id')
      .eq('company_id', companyId)
      .single()

    if (existingFeed) {
      return NextResponse.json(
        { error: 'Calendar feed already exists' },
        { status: 409 }
      )
    }

    // Create new feed. The route mints the token (same format as the column
    // default) so it can hand it out without reading the column back.
    const feedToken = crypto.randomUUID()
    const { data: feed, error } = await supabase
      .from('calendar_feeds')
      .insert({
        user_id: user.id,
        company_id: companyId,
        feed_token: feedToken,
        is_active: true,
        include_tax_deadlines: true,
        include_invoices: true,
      })
      .select(FEED_COLUMNS)
      .single()

    if (error) {
      return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })
    }

    return NextResponse.json({ data: withFeedUrls(feed, feedToken) })
  },
  { requireWrite: true },
)

/**
 * PUT /api/calendar/feed
 * Update calendar feed settings
 */
export const PUT = withRouteContext(
  'calendar_feed.update',
  async (request, ctx) => {
    const { supabase, companyId, log } = ctx

    const validation = await validateBody(request, UpdateFeedSchema, {
      log,
      operation: 'calendar_feed.update',
    })
    if (!validation.success) return validation.response

    const { data: feed, error } = await supabase
      .from('calendar_feeds')
      .update(validation.data)
      .eq('company_id', companyId)
      .select(FEED_COLUMNS)
      .single()

    if (error) {
      return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })
    }

    const feedToken = await readFeedToken(companyId, feed.id)
    return NextResponse.json({ data: withFeedUrls(feed, feedToken) })
  },
  { requireWrite: true },
)

/**
 * DELETE /api/calendar/feed
 * Regenerate calendar feed token (invalidates old URL)
 */
export const DELETE = withRouteContext(
  'calendar_feed.rotate_token',
  async (_request, ctx) => {
    const { supabase, companyId } = ctx

    // Generate a new token by updating with a new UUID
    const feedToken = crypto.randomUUID()
    const { data: feed, error } = await supabase
      .from('calendar_feeds')
      .update({
        feed_token: feedToken,
        access_count: 0,
        last_accessed_at: null,
      })
      .eq('company_id', companyId)
      .select(FEED_COLUMNS)
      .single()

    if (error) {
      return NextResponse.json({ error: getUserErrorMessage(error) }, { status: 500 })
    }

    return NextResponse.json({ data: withFeedUrls(feed, feedToken) })
  },
  { requireWrite: true },
)
