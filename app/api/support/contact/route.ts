import { NextResponse } from 'next/server'
import { requireAuth } from '@/lib/auth/require-auth'
import { getEmailService } from '@/lib/email/service'
import { getSupportRecipientEmail } from '@/lib/support'
import { requireCompanyId } from '@/lib/company/context'
import { ensureInitialized } from '@/lib/init'
import { getBranding } from '@/lib/branding/service'

ensureInitialized()

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export async function POST(request: Request) {
  const { user, supabase, error } = await requireAuth()
  if (error) return error

  await requireCompanyId(supabase, user.id)

  let body: { subject?: string; message?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const message = body.message?.trim()
  if (!message || message.length < 5) {
    return NextResponse.json({ error: 'Meddelandet måste vara minst 5 tecken' }, { status: 400 })
  }
  if (message.length > 5000) {
    return NextResponse.json({ error: 'Meddelandet får vara max 5000 tecken' }, { status: 400 })
  }

  const subject = body.subject?.trim() || 'Supportärende'

  const emailService = getEmailService()
  if (!emailService.isConfigured()) {
    return NextResponse.json(
      { error: 'E-posttjänsten är inte konfigurerad just nu. Försök igen senare.' },
      { status: 503 }
    )
  }

  const safeSubject = escapeHtml(subject)
  const safeMessage = escapeHtml(message).replace(/\n/g, '<br />')

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
    `,
    text: `Från: ${user.email}\nUser ID: ${user.id}\nÄmne: ${subject}\n\n${message}`,
  })

  if (!result.success) {
    return NextResponse.json(
      { error: 'Kunde inte skicka meddelandet. Försök igen.' },
      { status: 500 }
    )
  }

  return NextResponse.json({ data: { sent: true } })
}
