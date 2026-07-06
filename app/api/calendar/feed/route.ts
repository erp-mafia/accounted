import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'

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
  const baseUrl = process.env.NEXT_PUBLIC_APP_URL || 'https://app.erp-base.se'
  return {
    webcalUrl: `webcal://${baseUrl.replace(/^https?:\/\//, '')}/api/calendar/feed/${feedToken}`,
    httpsUrl: `${baseUrl}/api/calendar/feed/${feedToken}`,
  }
}

/**
 * GET /api/calendar/feed
 * Get current user's calendar feed settings
 */
export const GET = withRouteContext('calendar_feed.get', async (_request, ctx) => {
  const { supabase, companyId } = ctx

  const { data: feed, error } = await supabase
    .from('calendar_feeds')
    .select('*')
    .eq('company_id', companyId)
    .single()

  if (error && error.code !== 'PGRST116') {
    // PGRST116 = no rows returned, which is fine
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  if (feed) {
    return NextResponse.json({
      data: { ...feed, ...feedUrls(feed.feed_token) },
    })
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

    // Create new feed
    const { data: feed, error } = await supabase
      .from('calendar_feeds')
      .insert({
        user_id: user.id,
        company_id: companyId,
        is_active: true,
        include_tax_deadlines: true,
        include_invoices: true,
      })
      .select()
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({
      data: { ...feed, ...feedUrls(feed.feed_token) },
    })
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
      .select()
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({
      data: { ...feed, ...feedUrls(feed.feed_token) },
    })
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
    const { data: feed, error } = await supabase
      .from('calendar_feeds')
      .update({
        feed_token: crypto.randomUUID(),
        access_count: 0,
        last_accessed_at: null,
      })
      .eq('company_id', companyId)
      .select()
      .single()

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({
      data: { ...feed, ...feedUrls(feed.feed_token) },
    })
  },
  { requireWrite: true },
)
