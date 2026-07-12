import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'

export const GET = withRouteContext<{ params: Promise<{ sector: string; slug: string }> }>(
  'extension.data.get',
  async (request, { supabase, companyId }, { params }) => {
  const { sector, slug } = await params

  const extensionId = `${sector}/${slug}`

  const { searchParams } = new URL(request.url)
  const key = searchParams.get('key')

  let query = supabase
    .from('extension_data')
    .select('*')
    .eq('company_id', companyId)
    .eq('extension_id', extensionId)

  const prefix = searchParams.get('prefix')

  if (key) {
    query = query.eq('key', key)
  } else if (prefix) {
    query = query.ilike('key', `${prefix}%`)
  }

  const { data, error } = await query

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data })
  },
)

export const POST = withRouteContext<{ params: Promise<{ sector: string; slug: string }> }>(
  'extension.data.set',
  async (request, { supabase, user, companyId }, { params }) => {
  const { sector, slug } = await params

  const body = await request.json()
  const { key, value } = body

  if (!key) {
    return NextResponse.json({ error: 'key is required' }, { status: 400 })
  }

  const extensionId = `${sector}/${slug}`

  const { data, error } = await supabase
    .from('extension_data')
    .upsert(
      {
        user_id: user.id,
        company_id: companyId,
        extension_id: extensionId,
        key,
        value,
      },
      { onConflict: 'user_id,extension_id,key' }
    )
    .select()
    .single()

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ data })
  },
  { requireWrite: true },
)

export const DELETE = withRouteContext<{ params: Promise<{ sector: string; slug: string }> }>(
  'extension.data.delete',
  async (request, { supabase, companyId }, { params }) => {
  const { sector, slug } = await params

  const { searchParams } = new URL(request.url)
  const key = searchParams.get('key')

  if (!key) {
    return NextResponse.json({ error: 'key query parameter is required' }, { status: 400 })
  }

  const extensionId = `${sector}/${slug}`

  const { error } = await supabase
    .from('extension_data')
    .delete()
    .eq('company_id', companyId)
    .eq('extension_id', extensionId)
    .eq('key', key)

  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
  },
  { requireWrite: true },
)
