import { createServiceRoleClient } from '@/lib/supabase/service-client'
import { NextResponse } from 'next/server'
import { generateCalendarFeed } from '@/lib/calendar/ics-generator'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { createLogger } from '@/lib/logger'
import type { Deadline, Invoice } from '@/types'
import { createTokenRateLimiter } from '@/lib/api/token-rate-limit'
import { UUID_RE } from '@/lib/invariants/uuid'

const log = createLogger('api/calendar/feed-token')

// 60 requests per minute per token, process-local.
const rateLimiter = createTokenRateLimiter({ max: 60, windowMs: 60_000 })

/**
 * GET /api/calendar/feed/[token]
 * Returns an ICS calendar feed for the given token
 * No authentication required - the token IS the authentication
 */
export async function GET(
  request: Request,
  { params }: { params: Promise<{ token: string }> }
) {
  const { token } = await params

  // Validate token format (UUID)
  if (!UUID_RE.test(token)) {
    return new NextResponse('Invalid token', { status: 400 })
  }

  // Rate limiting per token
  if (!rateLimiter.allow(token)) {
    return new NextResponse('Too many requests', { status: 429 })
  }

  // Create service client (no user auth required)
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !supabaseServiceKey) {
    return new NextResponse('Server configuration error', { status: 500 })
  }

  const supabase = createServiceRoleClient(supabaseUrl, supabaseServiceKey)

  // Fetch feed settings by token
  const { data: feed, error: feedError } = await supabase
    .from('calendar_feeds')
    .select('*')
    .eq('feed_token', token)
    .eq('is_active', true)
    .single()

  if (feedError || !feed) {
    return new NextResponse('Feed not found or inactive', { status: 404 })
  }

  // Check token expiry
  if (feed.expires_at && new Date(feed.expires_at) < new Date()) {
    return new NextResponse('Feed token has expired', { status: 410 })
  }

  // The token authenticates the feed, but the feed's creator must still be a
  // member of the company: offboarding (removal from company_members) must
  // stop the feed, or an ex-member's subscribed calendar keeps receiving the
  // company's deadlines and invoice details indefinitely.
  const { data: membership } = await supabase
    .from('company_members')
    .select('user_id')
    .eq('company_id', feed.company_id)
    .eq('user_id', feed.user_id)
    .maybeSingle()

  if (!membership) {
    return new NextResponse('Feed not found or inactive', { status: 404 })
  }

  // Update access tracking
  await supabase
    .from('calendar_feeds')
    .update({
      last_accessed_at: new Date().toISOString(),
      access_count: feed.access_count + 1,
    })
    .eq('id', feed.id)

  // Calculate date range: 3 months back, 12 months forward
  const now = new Date()
  const startDate = new Date(now)
  startDate.setMonth(startDate.getMonth() - 3)
  const endDate = new Date(now)
  endDate.setMonth(endDate.getMonth() + 12)

  const startStr = startDate.toISOString().split('T')[0]
  const endStr = endDate.toISOString().split('T')[0]

  try {
    // Fetch relevant data based on feed options. Deadlines are always
    // fetched: include_tax_deadlines only hides SYSTEM rows (the generator
    // filters by source), while user-created deadlines always appear.
    // The secondary .order('id') gives the stable total order paging
    // requires: due dates cluster hard (invoice batches, tax deadlines), so
    // ordering by due_date alone leaves the page boundary inside a run of
    // tied rows, where Postgres may drop or repeat rows between pages.
    const [deadlines, invoices] = await Promise.all([
      fetchAllRows<Deadline>(
        ({ from, to }) =>
          supabase
            .from('deadlines')
            .select('*')
            .eq('company_id', feed.company_id)
            .is('dismissed_at', null)
            .gte('due_date', startStr)
            .lte('due_date', endStr)
            .order('due_date')
            .order('id')
            .range(from, to),
        { dedupeBy: (row) => row.id }
      ),

      // Invoices with a real due date to remind about: drafts, cancelled and
      // credited invoices have no payable due date and would leak
      // speculative amounts into the subscriber's calendar.
      feed.include_invoices
        ? fetchAllRows<Invoice>(
            ({ from, to }) =>
              supabase
                .from('invoices')
                .select('*, customer:customers(*)')
                .eq('company_id', feed.company_id)
                .in('status', ['sent', 'paid', 'partially_paid', 'overdue'])
                // A quote's due_date only mirrors its expiry; it is not a
                // payment date. Proformas and delivery notes are not owed.
                .eq('document_type', 'invoice')
                .gte('due_date', startStr)
                .lte('due_date', endStr)
                .order('due_date')
                .order('id')
                .range(from, to),
            { dedupeBy: (row) => row.id }
          )
        : Promise.resolve([]),
    ])

    const icsContent = await generateCalendarFeed(
      {
        deadlines,
        invoices,
      },
      {
        includeTaxDeadlines: feed.include_tax_deadlines,
        includeInvoices: feed.include_invoices,
      }
    )

    return new NextResponse(icsContent, {
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': 'attachment; filename="accounted.ics"',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
      },
    })
  } catch (error) {
    log.error('Error generating ICS feed', error as Error, { feedId: feed.id })
    return new NextResponse('Failed to generate calendar feed', { status: 500 })
  }
}
