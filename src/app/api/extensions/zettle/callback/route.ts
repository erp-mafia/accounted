import { completePartnerOAuthCallback } from '@/lib/auth/partner-oauth-callback'
import { encryptCredential } from '@/extensions/general/zettle/lib/credentials'
import { validateReturnOrigin } from '@/extensions/general/zettle/lib/return-origin'
import {
  exchangeCodeForTokens,
  fetchUserSelf,
} from '@/extensions/general/zettle/lib/oauth'

/**
 * GET /api/extensions/zettle/callback
 *
 * OAuth callback for Zettle partner authorization. Must be a real Next.js
 * route (not an extension dispatcher handler) because Zettle redirects the
 * user's browser to this URL directly. The flow itself (state lookup,
 * initiator binding, code replay guard, compare-and-set activation) is the
 * shared partner callback.
 */
export function GET(request: Request) {
  const appBase = (process.env.NEXT_PUBLIC_APP_URL || 'http://localhost:3000').replace(/\/$/, '')
  return completePartnerOAuthCallback(request, {
    extensionId: 'zettle',
    displayName: 'Zettle',
    provider: 'zettle',
    table: 'zettle_connections',
    pendingColumns: 'id, user_id, company_id, return_origin',
    // Return the browser to the origin the connect flow started on. Zettle
    // redirects to the one registered callback URL, so a white-label user
    // would otherwise land on the canonical app domain. The stored value is
    // re-validated here (members can update the row through RLS): the app
    // origin or a brand domain, never an arbitrary URL.
    returnUrl: async (row) =>
      `${await validateReturnOrigin((row?.return_origin as string | null | undefined) ?? null, appBase)}/import?mode=zettle`,
    async exchange(code) {
      const tokens = await exchangeCodeForTokens(code)
      const userSelf = await fetchUserSelf(tokens.access_token)
      // Seed the purchase cursor with the connection moment. Sales made
      // before the merchant connected are already in the books from the bank
      // side, so a first sync that reached further back would only
      // manufacture duplicates. Reaching further back is an explicit choice:
      // POST /api/extensions/ext/zettle/backfill with a start date.
      const connectedAt = new Date().toISOString()
      return {
        organization_uuid: userSelf.organizationUuid,
        organization_name: null,
        refresh_token_encrypted: encryptCredential(tokens.refresh_token),
        connected_at: connectedAt,
        last_order_synced_at: connectedAt,
        transaction_sync_enabled: true,
      }
    },
    activatedColumns: 'id, company_id, user_id, organization_uuid',
    conflictMessage: 'Zettle-organisationen är redan ansluten till ett företag.',
    clearOnFailure: { refresh_token_encrypted: null },
    connectedEvent: (row) => ({
      type: 'zettle.connected',
      payload: {
        connectionId: row.id as string,
        organizationUuid: row.organization_uuid as string,
        userId: row.user_id as string,
        companyId: row.company_id as string,
      },
    }),
  })
}
