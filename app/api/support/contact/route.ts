import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/require-auth'
import { getEmailService } from '@/lib/email/service'
import { getSupportRecipientEmail } from '@/lib/support'
import {
  SUPPORT_MAX_ATTACHMENTS,
  SUPPORT_MAX_ATTACHMENT_TOTAL_BYTES,
  SUPPORT_MAX_ATTACHMENT_TOTAL_MB,
  isSupportedAttachmentType,
  supportAttachmentFilename,
} from '@/lib/support/attachments'
import { validateDocumentMagicBytes } from '@/lib/core/documents/document-service'
import { requireCompanyId } from '@/lib/company/context'
import { ensureInitialized } from '@/lib/init'
import { getBranding } from '@/lib/branding/service'
import { getErrorMessage } from '@/lib/errors/get-error-message'

ensureInitialized()

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

interface ParsedAttachment {
  filename: string
  content: Buffer
  contentType: string
}

function hasUnsafePdfPrefix(buffer: ArrayBuffer): boolean {
  const bytes = new Uint8Array(buffer)
  const signatures = [
    [0x4d, 0x5a], // Windows executable
    [0x7f, 0x45, 0x4c, 0x46], // ELF executable
    [0x50, 0x4b, 0x03, 0x04], // ZIP container
    [0x23, 0x21], // Executable script
  ]
  return signatures.some(
    (signature) =>
      signature.length <= bytes.length &&
      signature.every((byte, index) => bytes[index] === byte)
  )
}

/**
 * Attachments are relayed through the existing email service. Their bytes are
 * checked against the declared type instead of trusting multipart headers.
 */
async function parseAttachments(
  files: File[]
): Promise<{ attachments: ParsedAttachment[] } | { error: string }> {
  if (files.length > SUPPORT_MAX_ATTACHMENTS) {
    return { error: `Du kan bifoga max ${SUPPORT_MAX_ATTACHMENTS} filer` }
  }

  const attachments: ParsedAttachment[] = []
  let totalBytes = 0

  for (const file of files) {
    const fileType = file.type.toLowerCase()
    if (!isSupportedAttachmentType(fileType)) {
      return { error: 'Bifogade filer måste vara bilder (JPG, PNG, WEBP) eller PDF' }
    }

    totalBytes += file.size
    if (totalBytes > SUPPORT_MAX_ATTACHMENT_TOTAL_BYTES) {
      return { error: `Bilagorna får väga max ${SUPPORT_MAX_ATTACHMENT_TOTAL_MB} MB tillsammans` }
    }

    const buffer = await file.arrayBuffer()
    if (fileType === 'application/pdf' && hasUnsafePdfPrefix(buffer)) {
      return { error: 'PDF-filen har ett ogiltigt innehåll' }
    }
    const magicError = validateDocumentMagicBytes(buffer, fileType)
    if (magicError) return { error: magicError }

    attachments.push({
      filename: supportAttachmentFilename(file.name, fileType),
      content: Buffer.from(buffer),
      contentType: fileType,
    })
  }

  return { attachments }
}

export async function POST(request: Request) {
  const { user, supabase, error } = await requireAuth()
  if (error) return error

  await requireCompanyId(supabase, user.id)

  let subjectRaw: string | undefined
  let messageRaw: string | undefined
  let files: File[] = []

  const contentType = request.headers.get('content-type') || ''
  if (contentType.includes('multipart/form-data')) {
    let form: FormData
    try {
      form = await request.formData()
    } catch {
      return NextResponse.json(
        { error: getErrorMessage('Invalid request body', { statusCode: 400 }) },
        { status: 400 }
      )
    }
    const subjectField = form.get('subject')
    const messageField = form.get('message')
    subjectRaw = typeof subjectField === 'string' ? subjectField : undefined
    messageRaw = typeof messageField === 'string' ? messageField : undefined
    files = form.getAll('files').filter((f): f is File => f instanceof File)
  } else {
    let body: { subject?: string; message?: string }
    try {
      body = await request.json()
    } catch {
      return NextResponse.json(
        { error: getErrorMessage('Invalid request body', { statusCode: 400 }) },
        { status: 400 }
      )
    }
    subjectRaw = body.subject
    messageRaw = body.message
  }

  const message = messageRaw?.trim()
  if (!message || message.length < 5) {
    return NextResponse.json({ error: 'Meddelandet måste vara minst 5 tecken' }, { status: 400 })
  }
  if (message.length > 5000) {
    return NextResponse.json({ error: 'Meddelandet får vara max 5000 tecken' }, { status: 400 })
  }

  const subject = subjectRaw?.trim() || 'Supportärende'

  const parsed = await parseAttachments(files)
  if ('error' in parsed) {
    return NextResponse.json(
      { error: getErrorMessage(parsed.error, { statusCode: 400 }) },
      { status: 400 }
    )
  }
  const { attachments } = parsed

  const emailService = getEmailService()
  if (!emailService.isConfigured()) {
    return NextResponse.json(
      { error: 'E-posttjänsten är inte konfigurerad just nu. Försök igen senare.' },
      { status: 503 }
    )
  }

  const safeSubject = escapeHtml(subject)
  const safeMessage = escapeHtml(message).replace(/\n/g, '<br />')
  // Named in the body as well as attached: a mail client that folds
  // attachments away otherwise hides the fact that they exist at all.
  const attachmentNames = attachments.map((a) => a.filename)
  const attachmentHtml = attachmentNames.length
    ? `<hr /><p><strong>Bilagor (${attachmentNames.length}):</strong> ${escapeHtml(attachmentNames.join(', '))}</p>`
    : ''
  const attachmentText = attachmentNames.length
    ? `\n\nBilagor (${attachmentNames.length}): ${attachmentNames.join(', ')}`
    : ''

  const result = await emailService.sendEmail({
    to: getSupportRecipientEmail(),
    subject: `[${getBranding().appName.toLowerCase()} support] ${subject}`,
    replyTo: user.email,
    html: `
      <p><strong>Från:</strong> ${escapeHtml(user.email || '')}</p>
      <p><strong>User ID:</strong> ${user.id}</p>
      <p><strong>Ämne:</strong> ${safeSubject}</p>
      <hr />
      <p>${safeMessage}</p>
      ${attachmentHtml}
    `,
    text: `Från: ${user.email}\nUser ID: ${user.id}\nÄmne: ${subject}\n\n${message}${attachmentText}`,
    attachments: attachments.length ? attachments : undefined,
  })

  if (!result.success) {
    return NextResponse.json(
      { error: 'Kunde inte skicka meddelandet. Försök igen.' },
      { status: 500 }
    )
  }

  return NextResponse.json({ data: { sent: true } })
}
