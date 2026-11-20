import { ShopifyConnectError } from './api-client'

/**
 * The one sentence the connect route answers when the store probe fails:
 * what Shopify refused and what the merchant changes there. Before PH 161
 * every failure read "check the address and that the app has read_orders",
 * which a merchant whose app version already had read_orders could not act
 * on: the store had never approved that version's new scope.
 */

/** Status for the connect route: 502 when Shopify could not be reached, else 400. */
export function connectFailureStatus(error: unknown): number {
  return error instanceof ShopifyConnectError && error.kind === 'unreachable' ? 502 : 400
}

const APPROVE_ON_STORE =
  'En behörighet som läggs till i en ny appversion gäller först när ändringen har godkänts på butiken: öppna appen i butikens Shopify-admin och godkänn de nya behörigheterna, eller avinstallera appen och installera den igen från Dev Dashboard.'

export function connectFailureMessage(error: unknown, shopDomain: string): string {
  if (!(error instanceof ShopifyConnectError)) {
    return 'Kunde inte ansluta till butiken med de angivna uppgifterna. Kontrollera adressen och att appen har behörigheten read_orders.'
  }
  switch (error.kind) {
    case 'app_not_installed':
      return `Appen är inte installerad i butiken ${shopDomain}. Öppna appen i Shopifys Dev Dashboard, välj Install app och installera den i just den butiken. Försök sedan ansluta igen.`
    case 'other_organization':
      return `Shopify låter inte appen ansluta till butiken ${shopDomain} eftersom appen och butiken hör till olika organisationer i Shopify. Skapa appen i Dev Dashboard för den organisation som äger butiken och använd den appens klient-ID och klienthemlighet.`
    case 'credentials_rejected':
      return `Shopify godtog inte klient-ID och klienthemlighet för butiken ${shopDomain}. Kontrollera att adressen är butikens myshopify.com-adress och att båda uppgifterna är kopierade från samma app i Dev Dashboard.`
    case 'orders_scope_not_granted': {
      const granted = error.grantedScopes ?? []
      const current =
        granted.length > 0
          ? `Godkänt på butiken nu: ${granted.join(', ')}.`
          : 'Butiken har inte godkänt någon behörighet för appen.'
      return `Butiken ${shopDomain} har inte godkänt behörigheten read_orders för appen. ${current} ${APPROVE_ON_STORE} Försök sedan ansluta igen.`
    }
    case 'orders_protected_data':
      return `Appen har behörigheten read_orders i butiken ${shopDomain}, men Shopify nekar ändå åtkomst till ordrarna. Ordrar räknas som skyddad kunddata: ge appen Protected customer data access i Dev Dashboard, släpp en ny version och godkänn den på butiken. Försök sedan ansluta igen.`
    case 'orders_access_denied':
      return `Shopify nekar appen åtkomst till ordrarna i butiken ${shopDomain}. Kontrollera att appens aktiva version har behörigheten read_orders och att den är godkänd på butiken. ${APPROVE_ON_STORE}`
    case 'unreachable':
      return `Kunde inte nå butiken ${shopDomain} hos Shopify just nu. Kontrollera adressen och försök igen om en stund.`
  }
}
