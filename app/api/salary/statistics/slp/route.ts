import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { requireCompanyId } from '@/lib/company/context'
import { z } from 'zod'
import { buildSlpFile } from '@/lib/salary/statistics/slp'
import { collectSlpEmployees } from '@/lib/salary/statistics/slp-data'

ensureInitialized()

const QuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  format: z.enum(['txt', 'json']).default('txt'),
})

export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const companyId = await requireCompanyId(supabase, user.id)

  const parsed = QuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Ange giltigt år' }, { status: 400 })
  }
  const { year, format } = parsed.data

  const { rows, error } = await collectSlpEmployees(supabase, companyId, year)
  if (error) return NextResponse.json({ error }, { status: 500 })

  const { data: company } = await supabase
    .from('companies')
    .select('org_number')
    .eq('id', companyId)
    .maybeSingle()

  const result = buildSlpFile(
    { year, orgNumber: company?.org_number ?? null, variant: 'scb' },
    rows,
  )

  if (format === 'json') {
    return NextResponse.json({ data: result })
  }

  return new NextResponse(result.content, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="SLP_${year}.txt"`,
    },
  })
}
