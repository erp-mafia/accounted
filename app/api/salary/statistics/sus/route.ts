import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { ensureInitialized } from '@/lib/init'
import { requireCompanyId } from '@/lib/company/context'
import { z } from 'zod'
import { buildSusFile } from '@/lib/salary/statistics/sus'
import { collectSusCases } from '@/lib/salary/statistics/sus-data'

ensureInitialized()

const QuerySchema = z.object({
  year: z.coerce.number().int().min(2000).max(2100),
  month: z.coerce.number().int().min(1).max(12),
  format: z.enum(['txt', 'json']).default('txt'),
})

export async function GET(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const companyId = await requireCompanyId(supabase, user.id)

  const parsed = QuerySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams))
  if (!parsed.success) {
    return NextResponse.json({ error: 'Ange giltigt år och månad (1–12)' }, { status: 400 })
  }
  const { year, month, format } = parsed.data

  const { cases, error } = await collectSusCases(supabase, companyId, year, month)
  if (error) return NextResponse.json({ error }, { status: 500 })

  const { data: company } = await supabase
    .from('companies')
    .select('org_number')
    .eq('id', companyId)
    .maybeSingle()

  const result = buildSusFile({ orgNumber: company?.org_number ?? null }, cases)

  if (format === 'json') {
    return NextResponse.json({ data: result })
  }

  const mm = String(month).padStart(2, '0')
  return new NextResponse(result.content, {
    status: 200,
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'Content-Disposition': `attachment; filename="SuS_${year}${mm}.txt"`,
    },
  })
}
