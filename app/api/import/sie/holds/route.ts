import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'

export const GET = withRouteContext('sie_import.holds',async (_request,{supabase,companyId}) => {
  const {data,error} = await supabase.from('fiscal_periods').select('id,name,import_hold')
    .eq('company_id',companyId).not('import_hold','is',null).order('period_start')
  if (error) throw error
  return NextResponse.json({data},{headers:{'Cache-Control':'no-store'}})
})
