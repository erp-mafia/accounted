import { createServiceRoleClient } from '@/lib/supabase/service-client'
import { NextResponse } from 'next/server'
import { generateCalendarFeed } from '@/lib/calendar/ics-generator'
import { fetchAllRows } from '@/lib/supabase/fetch-all'
import { createLogger } from '@/lib/logger'
import type { Deadline, Invoice } from '@/types'

const log = createLogger('api/calendar/feed-token')

// In-memory rate limiting: token -> { count, resetAt }
const rateLimitMap = new Map<string, { count: number; resetAt: number }>()
const RATE_LIMIT_WINDOW_MS = 60_000 // 1 minute
const RATE_LIMIT_MAX = 60 // 60 requests per minute per token

// Periodic cleanup to prevent memory leaks (every 5 minutes)
let lastCleanup = Date.now()
function cleanupRateLimitMap() {
  const now = Date.now()
  if (now - lastCleanup < 5 * 60_000) return
  lastCleanup = now
  for (const [key, value] of rateLimitMap) {
    if (now > value.resetAt) rateLimitMap.delete(key)
  }
}

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
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  if (!uuidRegex.test(token)) {
    return new NextResponse('Invalid token', { status: 400 })
  }

  // Rate limiting per token
  cleanupRateLimitMap()
  const nowMs = Date.now()
  const rateEntry = rateLimitMap.get(token)
  if (rateEntry && nowMs < rateEntry.resetAt) {
    if (rateEntry.count >= RATE_LIMIT_MAX) {
      return new NextResponse('Too many requests', { status: 429 })
    }
    rateEntry.count++
  } else {
    rateLimitMap.set(token, { count: 1, resetAt: nowMs + RATE_LIMIT_WINDOW_MS })
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

  // Fetch relevant data based on feed options. Deadlines are always
  // fetched: include_tax_deadlines only hides SYSTEM rows (the generator
  // filters by source), while user-created deadlines always appear.
  const [deadlines, invoices] = await Promise.all([
    fetchAllRows<Deadline>(({ from, to }) =>
      supabase
        .from('deadlines')
        .select('*')
        .eq('company_id', feed.company_id)
        .is('dismissed_at', null)
        .gte('due_date', startStr)
        .lte('due_date', endStr)
        .order('due_date')
        .range(from, to)
    ),

    // Invoices
    feed.include_invoices
      ? fetchAllRows<Invoice>(({ from, to }) =>
          supabase
            .from('invoices')
            .select('*, customer:customers(*)')
            .eq('company_id', feed.company_id)
            .gte('due_date', startStr)
            .lte('due_date', endStr)
            .order('due_date')
            .range(from, to)
        )
      : Promise.resolve([]),
  ])

  try {
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
