import { NextResponse } from 'next/server'
import { withRouteContext } from '@/lib/api/with-route-context'
import { createServiceClient } from '@/lib/supabase/server'
import {
  INVOICE_FONT_UPLOAD_MAX_BYTES,
  INVOICE_FONT_UPLOAD_MAX_MB,
} from '@/lib/invoices/branding-constants'
import {
  detectInvoiceFontFileFormat,
  getInvoiceFontContentType,
} from '@/lib/invoices/font-files'
import { getErrorMessage as getUserErrorMessage } from '@/lib/errors/get-error-message'

const ALLOWED_EXTENSIONS = new Set(['ttf', 'woff'])

function safeDisplayName(fileName: string, extension: string): string {
  const baseName = fileName.split(/[\\/]/).pop() ?? `invoice-font.${extension}`
  const cleaned = baseName.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return (cleaned || `invoice-font.${extension}`).slice(0, 200)
}

export const POST = withRouteContext(
  'settings.invoice-font.upload',
  async (request, { supabase, companyId }) => {
    const formData = await request.formData()
    const file = formData.get('file')
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'Ingen typsnittsfil angiven.' }, { status: 400 })
    }

    const extension = file.name.split('.').pop()?.toLowerCase() ?? ''
    if (!ALLOWED_EXTENSIONS.has(extension)) {
      return NextResponse.json(
        { error: 'Otillåten filtyp. Tillåtna format är TTF och WOFF.' },
        { status: 400 },
      )
    }

    if (file.size > INVOICE_FONT_UPLOAD_MAX_BYTES) {
      return NextResponse.json(
        { error: `Filen är för stor (max ${INVOICE_FONT_UPLOAD_MAX_MB} MB).` },
        { status: 400 },
      )
    }

    const bytes = Buffer.from(await file.arrayBuffer())
    const format = detectInvoiceFontFileFormat(bytes)
    if (!format || format !== extension) {
      return NextResponse.json(
        { error: 'Filen är inte ett giltigt TTF- eller WOFF-typsnitt.' },
        { status: 400 },
      )
    }

    const fileName = `invoice-font-${Date.now()}.${format}`
    const storagePath = `${companyId}/${fileName}`
    const serviceClient = createServiceClient()
    const bucket = serviceClient.storage.from('invoice-fonts')

    const { error: uploadError } = await bucket.upload(storagePath, bytes, {
      contentType: getInvoiceFontContentType(format),
      upsert: false,
    })
    if (uploadError) {
      return NextResponse.json(
        { error: `Uppladdning misslyckades: ${getUserErrorMessage(uploadError)}` },
        { status: 500 },
      )
    }

    const displayName = safeDisplayName(file.name, format)
    const { error: updateError } = await supabase
      .from('company_settings')
      .update({
        invoice_font_family: 'Custom',
        invoice_custom_font_path: storagePath,
        invoice_custom_font_name: displayName,
      })
      .eq('company_id', companyId)
      .select('company_id')
      .single()

    if (updateError) {
      await bucket.remove([storagePath])
      if (updateError.code === 'PGRST116') {
        return NextResponse.json({ error: 'Inställningarna hittades inte.' }, { status: 404 })
      }
      return NextResponse.json(
        { error: getUserErrorMessage(updateError) },
        { status: 500 },
      )
    }

    const { data: existing } = await bucket.list(companyId)
    const obsoletePaths = (existing ?? [])
      .filter((stored) => stored.name !== fileName)
      .map((stored) => `${companyId}/${stored.name}`)
    if (obsoletePaths.length > 0) await bucket.remove(obsoletePaths)

    return NextResponse.json({
      data: {
        invoice_font_family: 'Custom',
        invoice_custom_font_path: storagePath,
        invoice_custom_font_name: displayName,
      },
    })
  },
  { requireWrite: true },
)

export const DELETE = withRouteContext(
  'settings.invoice-font.delete',
  async (_request, { supabase, companyId }) => {
    const { error: updateError } = await supabase
      .from('company_settings')
      .update({
        invoice_font_family: 'Helvetica',
        invoice_custom_font_path: null,
        invoice_custom_font_name: null,
      })
      .eq('company_id', companyId)
      .select('company_id')
      .single()

    if (updateError) {
      if (updateError.code === 'PGRST116') {
        return NextResponse.json({ error: 'Inställningarna hittades inte.' }, { status: 404 })
      }
      return NextResponse.json(
        { error: getUserErrorMessage(updateError) },
        { status: 500 },
      )
    }

    const serviceClient = createServiceClient()
    const bucket = serviceClient.storage.from('invoice-fonts')
    const { data: existing } = await bucket.list(companyId)
    if (existing && existing.length > 0) {
      await bucket.remove(existing.map((stored) => `${companyId}/${stored.name}`))
    }

    return NextResponse.json({
      data: {
        invoice_font_family: 'Helvetica',
        invoice_custom_font_path: null,
        invoice_custom_font_name: null,
      },
    })
  },
  { requireWrite: true },
)
