import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'

export const GET = withRouteContext<{ params: Promise<{ sector: string; slug: string }> }>(
  'extension.settings.get',
  async (_request, { supabase, companyId }, { params }) => {
  const { sector, slug } = await params

  const extensionId = `${sector}/${slug}`

  const { data } = await supabase
    .from('extension_data')
    .select('value')
    .eq('company_id', companyId)
    .eq('extension_id', extensionId)
    .eq('key', 'settings')
    .single()

  return NextResponse.json({ data: data?.value ?? {} })
  },
)

export const PATCH = withRouteContext<{ params: Promise<{ sector: string; slug: string }> }>(
  'extension.settings.update',
  async (request, { supabase, user, companyId }, { params }) => {
  const { sector, slug } = await params

  const body = await request.json()
  const extensionId = `${sector}/${slug}`

  // Get existing settings and merge
  const { data: existing } = await supabase
    .from('extension_data')
    .select('value')
    .eq('company_id', companyId)
    .eq('extension_id', extensionId)
    .eq('key', 'settings')
    .single()

  const mergedSettings = { ...(existing?.value ?? {}), ...body }

  const { data, error } = await supabase
    .from('extension_data')
    .upsert(
      {
        user_id: user.id,
        company_id: companyId,
        extension_id: extensionId,
        key: 'settings',
        value: mergedSettings,
      },
      { onConflict: 'user_id,extension_id,key' }
    )
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data: data.value })
  },
  { requireWrite: true },
)
