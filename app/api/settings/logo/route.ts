import { createClient } from '@/lib/supabase/server'
import { NextResponse } from 'next/server'
import { requireCompanyId } from '@/lib/company/context'

const MAX_SIZE = 2 * 1024 * 1024 // 2MB
const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp']

export async function POST(request: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const companyId = await requireCompanyId(supabase, user.id)
  if (!companyId) return NextResponse.json({ error: 'No company' }, { status: 403 })

  const formData = await request.formData()
  const file = formData.get('file') as File | null

  if (!file) {
    return NextResponse.json({ error: 'Ingen fil angiven' }, { status: 400 })
  }

  if (!ALLOWED_TYPES.includes(file.type)) {
    return NextResponse.json({ error: 'Otillåten filtyp. Tillåtna: PNG, JPG, SVG, WebP.' }, { status: 400 })
  }

  if (file.size > MAX_SIZE) {
    return NextResponse.json({ error: 'Filen är för stor (max 2 MB).' }, { status: 400 })
  }

  const buffer = Buffer.from(await file.arrayBuffer())
  const ext = file.name.split('.').pop() || 'png'
  const storagePath = `logos/${companyId}/logo.${ext}`

  // Upload (upsert to replace existing)
  const { error: uploadError } = await supabase.storage
    .from('documents')
    .upload(storagePath, buffer, {
      contentType: file.type,
      upsert: true,
    })

  if (uploadError) {
    return NextResponse.json({ error: `Uppladdning misslyckades: ${uploadError.message}` }, { status: 500 })
  }

  // Get public URL
  const { data: urlData } = supabase.storage
    .from('documents')
    .getPublicUrl(storagePath)

  // Update company settings
  const { error: updateError } = await supabase
    .from('company_settings')
    .update({ logo_url: urlData.publicUrl })
    .eq('company_id', companyId)

  if (updateError) {
    return NextResponse.json({ error: 'Kunde inte uppdatera inställningar' }, { status: 500 })
  }

  return NextResponse.json({ data: { logo_url: urlData.publicUrl } })
}

export async function DELETE() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const companyId = await requireCompanyId(supabase, user.id)
  if (!companyId) return NextResponse.json({ error: 'No company' }, { status: 403 })

  // Get current logo path
  const { data: settings } = await supabase
    .from('company_settings')
    .select('logo_url')
    .eq('company_id', companyId)
    .single()

  if (settings?.logo_url) {
    // Extract storage path from URL
    const url = new URL(settings.logo_url)
    const pathMatch = url.pathname.match(/\/object\/public\/documents\/(.+)/)
    if (pathMatch) {
      await supabase.storage.from('documents').remove([pathMatch[1]])
    }
  }

  // Clear logo_url
  await supabase
    .from('company_settings')
    .update({ logo_url: null })
    .eq('company_id', companyId)

  return NextResponse.json({ data: { logo_url: null } })
}
