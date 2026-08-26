import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/require-auth'
import { checkRateLimit } from '@/lib/auth/rate-limit-http'
import { getEmailService } from '@/lib/email/service'
import { getSupportRecipientEmail } from '@/lib/support'
import {
  SUPPORT_MAX_ATTACHMENTS,
  SUPPORT_MAX_ATTACHMENT_TOTAL_BYTES,
  isSupportedAttachmentType,
  sanitizeAttachmentFilename,
} from '@/lib/support/attachments'
import { validateDocumentMagicBytes } from '@/lib/core/documents/document-service'
import { requireCompanyId } from '@/lib/company/context'
import { ensureInitialized } from '@/lib/init'
import { getBranding } from '@/lib/branding/service'

ensureInitialized()

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

interface ParsedAttachment {
  filename: string
  content: Buffer
  contentType: string
}

/**
 * Attachments are relayed on the mail and never persisted: nothing here writes
 * to the document archive, so a screenshot cannot end up under BFL retention.
 * They do go out over our own sending domain, which is why the bytes are
 * checked against the declared type instead of trusting the multipart headers.
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
    if (!isSupportedAttachmentType(file.type)) {
      return { error: 'Bifogade filer måste vara bilder (JPG, PNG, WEBP) eller PDF' }
    }

    totalBytes += file.size
    if (totalBytes > SUPPORT_MAX_ATTACHMENT_TOTAL_BYTES) {
      const limitMb = (SUPPORT_MAX_ATTACHMENT_TOTAL_BYTES / 1024 / 1024).toFixed(1).replace('.', ',')
      return { error: `Bilagorna får väga max ${limitMb} MB tillsammans` }
    }

    const buffer = await file.arrayBuffer()
    const magicError = validateDocumentMagicBytes(buffer, file.type)
    if (magicError) return { error: magicError }

    attachments.push({
      filename: sanitizeAttachmentFilename(file.name),
      content: Buffer.from(buffer),
      contentType: file.type,
    })
  }

  return { attachments }
}

export async function POST(request: Request) {
  const { user, supabase, error } = await requireAuth()
  if (error) return error

  await requireCompanyId(supabase, user.id)

  // The route now relays user-supplied files over our own sending domain. The
  // cap is generous enough that nobody reporting a real problem meets it, and
  // low enough that the support mailbox cannot be used as a file pipe.
  const limit = await checkRateLimit({
    prefix: 'support-contact',
    identifier: user.id,
    maxRequests: 10,
    windowMs: 60 * 60 * 1000,
  })
  if (!limit.ok && limit.response) return limit.response

  let subjectRaw: string | undefined
  let messageRaw: string | undefined
  let files: File[] = []

  const contentType = request.headers.get('content-type') || ''
  if (contentType.includes('multipart/form-data')) {
    let form: FormData
    try {
      form = await request.formData()
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
    }
    const subjectField = form.get('subject')
    const messageField = form.get('message')
    subjectRaw = typeof subjectField === 'string' ? subjectField : undefined
    messageRaw = typeof messageField === 'string' ? messageField : undefined
    // An empty file input still produces a zero-byte entry in some browsers.
    files = form.getAll('files').filter((f): f is File => f instanceof File && f.size > 0)
  } else {
    let body: { subject?: string; message?: string }
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
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

  // Bounded before it reaches a mail header: the subject is user input now
  // that the dialog lets people type their own.
  const subject = subjectRaw?.trim().slice(0, 200) || 'Supportärende'

  const parsed = await parseAttachments(files)
  if ('error' in parsed) {
    return NextResponse.json({ error: parsed.error }, { status: 400 })
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

  return NextResponse.json({ data: { sent: true, attachments: attachments.length } })
}
