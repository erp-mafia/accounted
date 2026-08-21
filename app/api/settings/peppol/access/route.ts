import { NextResponse } from 'next/server'
import { z } from 'zod'
import { privateNoStore } from '@/lib/api/private-no-store'
import { validateBody } from '@/lib/api/validate'
import { withRouteContext } from '@/lib/api/with-route-context'
import { getBranding } from '@/lib/branding/service'
import { getEmailService } from '@/lib/email/service'
import { errorResponse, errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { ensureInitialized } from '@/lib/init'
import {
  getPeppolAccessSummary,
  requestPeppolAccess,
} from '@/lib/invoices/peppol-access'
import { isSandboxCompany } from '@/lib/sandbox/guard'
import { createServiceClient } from '@/lib/supabase/server'
import { getSupportRecipientEmail } from '@/lib/support'

ensureInitialized()

const RequestAccessSchema = z.object({
  note: z.string().trim().max(1800).optional(),
  /** The company also wants to receive (one of the contracted tenant slots). */
  wants_receiving: z.boolean().optional(),
})

function escapeHtml(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * POST /api/settings/peppol/access: the company asks for Peppol access.
 *
 * Writes the request row (service role; the browser cannot grant itself
 * anything) and tells the operators by e-mail. The e-mail is best-effort: the
 * row is the source of truth and the operators' script lists open requests.
 */
export const POST = withRouteContext(
  'settings.peppol.access.request',
  async (request, { supabase, companyId, user, log, requestId }) => {
    const validation = await validateBody(request, RequestAccessSchema)
    if (!validation.success) return validation.response
    const wantsReceiving = validation.data.wants_receiving === true
    const userNote = validation.data.note?.trim() || null
    // The receiving wish travels in the request note so the operators see it
    // in `access.ts list` and in the mail, and grant it with --receive.
    const note = [wantsReceiving ? '[vill ta emot e-fakturor]' : null, userNote]
      .filter((part): part is string => !!part)
      .join(' ') || null

    if (await isSandboxCompany(supabase, companyId)) {
      return privateNoStore(errorResponseFromCode('PEPPOL_SANDBOX_NOT_ALLOWED', log, { requestId }))
    }

    const service = createServiceClient()
    try {
      const result = await requestPeppolAccess({ service, companyId, userId: user.id, note })
      if (!result.ok) {
        return privateNoStore(errorResponseFromCode(result.code, log, { requestId }))
      }

      if (result.created) {
        const { data: company } = await supabase
          .from('company_settings')
          .select('company_name, org_number')
          .eq('company_id', companyId)
          .maybeSingle()
        const emailService = getEmailService()
        if (emailService.isConfigured()) {
          const companyName = (company as { company_name?: string | null } | null)?.company_name ?? 'okänt bolag'
          const orgNumber = (company as { org_number?: string | null } | null)?.org_number ?? 'saknas'
          const sent = await emailService.sendEmail({
            to: getSupportRecipientEmail(),
            subject: `[${getBranding().appName.toLowerCase()} peppol] Åtkomstbegäran${wantsReceiving ? ' (+ mottagning)' : ''}: ${companyName}`,
            replyTo: user.email,
            html: [
              `<p><strong>Bolag:</strong> ${escapeHtml(companyName)} (${escapeHtml(orgNumber)})</p>`,
              `<p><strong>Company ID:</strong> ${companyId}</p>`,
              `<p><strong>Begärd av:</strong> ${escapeHtml(user.email ?? '')} (${user.id})</p>`,
              note ? `<hr /><p>${escapeHtml(note).replace(/\n/g, '<br />')}</p>` : '',
              `<hr /><p>Aktivera: <code>npx tsx --env-file=.env.local scripts/peppol/access.ts enable ${companyId} --max-sends 50${wantsReceiving ? ' --receive' : ''}</code></p>`,
            ].join('\n'),
            text: `Bolag: ${companyName} (${orgNumber})\nCompany ID: ${companyId}\nBegärd av: ${user.email ?? ''} (${user.id})\n\n${note ?? ''}\n\nAktivera: npx tsx --env-file=.env.local scripts/peppol/access.ts enable ${companyId} --max-sends 50${wantsReceiving ? ' --receive' : ''}`,
          })
          if (!sent.success) {
            log.warn('peppol access request e-mail failed', { companyId, reason: sent.error })
          }
        } else {
          log.warn('peppol access request: e-mail service not configured, request recorded only', { companyId })
        }
      }

      const summary = await getPeppolAccessSummary({ supabase: service, service, companyId })
      return privateNoStore(NextResponse.json({ data: { access: summary } }, { status: result.created ? 201 : 200 }))
    } catch (err) {
      return privateNoStore(errorResponse(err, log, { requestId }))
    }
  },
  { requireWrite: true },
)
