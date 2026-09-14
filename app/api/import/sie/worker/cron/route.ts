import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { runSIEWorker } from '@/lib/import/sie-job-worker'

export const maxDuration = 300

export const GET = withCronContext('cron.sie_import_worker',async (_request,ctx) => {
  const results = await Promise.all([runSIEWorker(),runSIEWorker()])
  const result = results.reduce((sum,r) => ({jobs:sum.jobs+r.jobs,chunks:sum.chunks+r.chunks}),{jobs:0,chunks:0})
  ctx.log.info('SIE worker completed invocation',result)
  return NextResponse.json({data:result})
})
