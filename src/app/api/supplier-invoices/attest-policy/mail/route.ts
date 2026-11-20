import { NextResponse } from 'next/server'
import { z } from 'zod'
import { withRouteContext } from '@/lib/api/with-route-context'
import { validateBody } from '@/lib/api/validate'
import { saveAttestMailPreference } from '@/lib/supplier-invoices/attest-settings'

const MailPreferenceBody = z.object({ enabled: z.boolean() }).strict()

/**
 * PUT /api/supplier-invoices/attest-policy/mail: the signed-in user's own
 * switch for the attest mail (Godkänn / Neka links when an invoice waits for
 * their attest). A personal preference: any member, their own row only.
 */
export const PUT = withRouteContext('supplier_invoice.attest_mail.update', async (request, { supabase, user }) => {
  const validation = await validateBody(request, MailPreferenceBody)
  if (!validation.success) return validation.response
  await saveAttestMailPreference(supabase, user.id, validation.data.enabled)
  return NextResponse.json({ data: { enabled: validation.data.enabled } })
})
