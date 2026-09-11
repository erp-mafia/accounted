import { NextResponse } from 'next/server'
import { withCronContext } from '@/lib/api/with-cron-context'
import { createServiceClientNoCookies } from '@/lib/auth/api-keys'

export const maxDuration = 60

export const GET = withCronContext('cron.sie_import_invariants',async (_request,ctx) => {
  const {data,error} = await createServiceClientNoCookies().rpc('check_sie_import_invariants')
  if (error) throw error
  const broken = Number(data.duplicate_groups)+Number(data.missing_holds)+Number(data.stale_holds) > 0
  if (broken) ctx.log.error('SIE ledger invariant violated',new Error('SIE_IMPORT_INVARIANT'),{alert:true,...data})
  else ctx.log.info('SIE ledger invariants checked',data)
  return NextResponse.json({data},{status:broken ? 503 : 200})
})
