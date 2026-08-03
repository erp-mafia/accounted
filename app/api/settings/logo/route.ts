import { NextResponse } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'
import { LOGO_UPLOAD_MAX_BYTES, LOGO_UPLOAD_MAX_MB } from '@/lib/invoices/branding-constants'
import {
  LOGO_BUCKET,
  cleanupPreviousCompanyLogos,
  createLogoStoragePath,
  isLogoMimeType,
} from '@/lib/invoices/company-logo'

export const POST = withRouteContext(
  'settings.logo.upload',
  async (request, { supabase, companyId, log }) => {
    const formData = await request.formData()
    const file = formData.get('file') as File | null

    if (!file) {
      return NextResponse.json({ error: 'Ingen fil angiven' }, { status: 400 })
    }

    if (!isLogoMimeType(file.type)) {
      return NextResponse.json({ error: 'Otillåten filtyp. Tillåtna: PNG, JPG, SVG, WebP.' }, { status: 400 })
    }

    if (file.size > LOGO_UPLOAD_MAX_BYTES) {
      return NextResponse.json({ error: `Filen är för stor (max ${LOGO_UPLOAD_MAX_MB} MB).` }, { status: 400 })
    }

    const buffer = Buffer.from(await file.arrayBuffer())
    const storagePath = createLogoStoragePath(companyId, file.type)

    const serviceClient = createServiceClient()
    const logoBucket = serviceClient.storage.from(LOGO_BUCKET)

    const { error: uploadError } = await logoBucket.upload(storagePath, buffer, {
        contentType: file.type,
        upsert: false,
      })

    if (uploadError) {
      return NextResponse.json({ error: `Uppladdning misslyckades: ${getUserErrorMessage(uploadError)}` }, { status: 500 })
    }

    const { data: urlData } = logoBucket.getPublicUrl(storagePath)

    // Update company settings
    const { error: updateError } = await supabase
      .from('company_settings')
      .update({ logo_url: urlData.publicUrl })
      .eq('company_id', companyId)

    if (updateError) {
      // The previous logo remains active. Remove only the unreferenced upload.
      await logoBucket.remove([storagePath])
      return NextResponse.json({ error: 'Kunde inte uppdatera inställningar' }, { status: 500 })
    }

    const cleanupError = await cleanupPreviousCompanyLogos(logoBucket, companyId, storagePath)
    if (cleanupError) {
      log.warn('Failed to clean up superseded company logos', cleanupError as Error, {
        storagePath,
      })
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
        .from(LOGO_BUCKET)
        .list(companyId)
      if (existing && existing.length > 0) {
        await serviceClient.storage
          .from(LOGO_BUCKET)
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
