import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { LOGO_UPLOAD_MAX_BYTES, LOGO_UPLOAD_MAX_MB } from '@/lib/invoices/branding-constants'
import { detectFileMagic } from '@/lib/core/documents/document-service'

/**
 * Raster formats only, decided by the file's magic bytes (detectFileMagic),
 * never by the client-declared Content-Type. The logos bucket is PUBLIC and
 * the object is served under the type stored here: an SVG (or an HTML file
 * declared as an image) would be a script-capable document on a public URL,
 * so SVG is not accepted at all and a declared type that disagrees with the
 * bytes is ignored in favour of the bytes.
 */
const LOGO_TYPE_EXTENSIONS: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}
const LOGO_TYPE_ERROR = 'Otillåten filtyp. Tillåtna: PNG, JPG, WebP.'

export const POST = withRouteContext(
  'settings.logo.upload',
  async (request, { supabase, companyId }) => {
    const formData = await request.formData()
    const file = formData.get('file') as File | null

    if (!file) {
      return NextResponse.json({ error: 'Ingen fil angiven' }, { status: 400 })
    }

    if (file.size > LOGO_UPLOAD_MAX_BYTES) {
      return NextResponse.json({ error: `Filen är för stor (max ${LOGO_UPLOAD_MAX_MB} MB).` }, { status: 400 })
    }

    const buffer = Buffer.from(await file.arrayBuffer())
    const detectedType = detectFileMagic(new Uint8Array(buffer))
    const ext = detectedType ? LOGO_TYPE_EXTENSIONS[detectedType] : undefined
    if (!detectedType || !ext) {
      return NextResponse.json({ error: LOGO_TYPE_ERROR }, { status: 400 })
    }
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
        contentType: detectedType,
        upsert: true,
      })

    if (uploadError) {
      return NextResponse.json({ error: `Uppladdning misslyckades: ${getUserErrorMessage(uploadError)}` }, { status: 500 })
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
