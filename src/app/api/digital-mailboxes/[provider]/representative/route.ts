import { NextResponse } from 'next/server'
import { privateNoStore } from '@/lib/api/private-no-store'
import { withRouteContext } from '@/lib/api/with-route-context'
import { billoRepresentativePreview, loadCompanyIdentity } from '@/lib/digital-mailboxes/connect'
import { errorResponseFromCode } from '@/lib/errors/get-structured-error'
import { createServiceClient } from '@/lib/supabase/server'

/**
 * GET /api/digital-mailboxes/billo/representative: what the "Skapa
 * Billo-brevlåda" dialog shows before anything leaves Accounted: the
 * company's name and address as Billo will get them, and the admin as the
 * representative (BankID name, whether a BankID personnummer is on file,
 * their email). The personnummer itself is never answered. Billo only:
 * Kivra's onboarding happens at Kivra.
 */
export const GET = withRouteContext<{ params: Promise<{ provider: string }> }>(
  'digital_mailboxes.representative',
  async (_request, { companyId, user, log, requestId }, { params }) => {
    const { provider } = await params
    if (provider !== 'billo') return errorResponseFromCode('DIGITAL_MAILBOX_UNKNOWN_PROVIDER', log, { requestId })
    const service = createServiceClient()
    const [preview, identity] = await Promise.all([
      billoRepresentativePreview(service, user.id),
      loadCompanyIdentity(service, companyId),
    ])
    return privateNoStore(
      NextResponse.json({
        data: {
          representative: { name: preview.name, has_bankid: preview.hasBankIdPersonnummer, email: user.email ?? null },
          company: identity
            ? {
                name: identity.name,
                org_number: identity.orgNumber,
                address_line1: identity.addressLine1,
                postal_code: identity.postalCode,
                city: identity.city,
              }
            : null,
        },
      }),
    )
  },
  { requireAdmin: true },
)
