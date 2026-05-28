import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'

export const GET = withCronContext('cron.invoice_reminders', async (_request, ctx) => {
  ctx.log.info('invoice reminders feature is disabled; skipping run')
  return NextResponse.json({ disabled: true }, { status: 503 })
})

export const POST = GET
