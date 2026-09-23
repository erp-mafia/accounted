import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { runSIEWorker } from '@/lib/import/sie-job-worker'
import { runPendingSIEBankSweeps } from '@/lib/import/sie-post-import-sweep'

export const maxDuration = 300

export const GET = withCronContext('cron.sie_import_worker',async (_request,ctx) => {
  // Alongside the workers, never after them: a long import must not starve the
  // recovery of a post-import bank sweep (#2835). It never throws.
  const [sweeps,...results] = await Promise.all([runPendingSIEBankSweeps(),runSIEWorker(),runSIEWorker()])
  const result = results.reduce((sum,r) => ({jobs:sum.jobs+r.jobs,chunks:sum.chunks+r.chunks}),{jobs:0,chunks:0})
  ctx.log.info('SIE worker completed invocation',{...result,bankSweeps:sweeps})
  return NextResponse.json({data:{...result,bankSweeps:sweeps}})
})
