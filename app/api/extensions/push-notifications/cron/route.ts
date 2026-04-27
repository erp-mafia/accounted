import { createClient } from '@supabase/supabase-js'
import { NextResponse } from 'next/server'
import { loadExtensions } from '@/lib/extensions/loader'
import { verifyCronSecret } from '@/lib/auth/cron'
import {
  sendTaxDeadlineNotifications,
  sendInvoiceNotifications,
  sendMissingUnderlagNotifications,
} from '@/extensions/general/push-notifications/notification-scheduler'

/**
 * GET /api/extensions/push-notifications/cron
 * Daily cron job to send push notifications
 * Runs at 09:00 every day
 *
 * Vercel Cron: "0 9 * * *"
 */
export async function GET(request: Request) {
  // Ensure extensions are loaded so event handlers are registered
  loadExtensions()

  const authError = verifyCronSecret(request)
  if (authError) return authError

  // Create a service role client for accessing all user data
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !supabaseServiceKey) {
    return NextResponse.json(
      { error: 'Missing Supabase configuration' },
      { status: 500 }
    )
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey)

  try {
    // Send all notification types in parallel
    const [taxResult, invoiceResult, underlagResult] = await Promise.all([
      sendTaxDeadlineNotifications(supabase),
      sendInvoiceNotifications(supabase),
      sendMissingUnderlagNotifications(supabase),
    ])

    const totalSent = taxResult.sent + invoiceResult.sent + underlagResult.sent
    const totalSkipped = taxResult.skipped + invoiceResult.skipped + underlagResult.skipped

    console.log(
      `Push notification cron completed: ${totalSent} sent, ${totalSkipped} skipped`
    )
    console.log(
      `  Tax: ${taxResult.sent} sent, ${taxResult.skipped} skipped`
    )
    console.log(
      `  Invoice: ${invoiceResult.sent} sent, ${invoiceResult.skipped} skipped`
    )
    console.log(
      `  Missing underlag: ${underlagResult.sent} sent, ${underlagResult.skipped} skipped`
    )

    return NextResponse.json({
      success: true,
      totalSent,
      totalSkipped,
      details: {
        taxDeadlines: taxResult,
        invoices: invoiceResult,
        missingUnderlag: underlagResult,
      },
    })
  } catch (error) {
    console.error('Error in push notification cron:', error)
    return NextResponse.json(
      { error: 'Failed to send push notifications' },
      { status: 500 }
    )
  }
}
