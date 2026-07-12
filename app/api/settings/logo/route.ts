import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { withRouteContext } from '@/lib/api/with-route-context'

const MAX_SIZE = 2 * 1024 * 1024 // 2MB
const ALLOWED_TYPES = ['image/png', 'image/jpeg', 'image/svg+xml', 'image/webp']

export const POST = withRouteContext(
  'settings.logo.upload',
  async (request, { supabase, companyId }) => {
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
    const mimeToExt: Record<string, string> = {
      'image/png': 'png',
      'image/jpeg': 'jpg',
      'image/svg+xml': 'svg',
      'image/webp': 'webp',
    }
    const ext = mimeToExt[file.type] ?? 'png'
    const storagePath = `${companyId}/logo-${Date.now()}.${ext}`

    const serviceClient = createServiceClient()

    // Remove any previous logo files for this company so we don't pile up orphans.
    const { data: existing } = await serviceClient.storage
      .from('logos')
      .list(companyId)
    if (existing && existing.length > 0) {
      await serviceClient.storage
        .from('logos')
        .remove(existing.map((f) => `${companyId}/${f.name}`))
    }

    const { error: uploadError } = await serviceClient.storage
      .from('logos')
      .upload(storagePath, buffer, {
        contentType: file.type,
        upsert: true,
      })

    if (uploadError) {
      return NextResponse.json({ error: `Uppladdning misslyckades: ${uploadError.message}` }, { status: 500 })
    }

    const { data: urlData } = serviceClient.storage
      .from('logos')
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
  },
  { requireWrite: true },
)

export const DELETE = withRouteContext(
  'settings.logo.delete',
  async (_request, { supabase, companyId }) => {
    // Get current logo path
    const { data: settings } = await supabase
      .from('company_settings')
      .select('logo_url')
      .eq('company_id', companyId)
      .single()

    if (settings?.logo_url) {
      const serviceClient = createServiceClient()
      const { data: existing } = await serviceClient.storage
        .from('logos')
        .list(companyId)
      if (existing && existing.length > 0) {
        await serviceClient.storage
          .from('logos')
          .remove(existing.map((f) => `${companyId}/${f.name}`))
      }
    }

    // Clear logo_url
    await supabase
      .from('company_settings')
      .update({ logo_url: null })
      .eq('company_id', companyId)

    return NextResponse.json({ data: { logo_url: null } })
  },
  { requireWrite: true },
)
