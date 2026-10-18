/**
 * The domains whose icon is never fetched, in one place (founder decision
 * 2026-10-17). Checked when a domain is resolved, again when it is queued,
 * and again by the fetcher itself, so a domain on this list never reaches
 * the network whatever path named it.
 *
 *   - Skatteverket: its API terms forbid its logo in the app (decision
 *     2026-10-13; Momsdeklaration 7.2, Ombudshantering 10).
 *   - Banks: the app draws its own bank logos (lib/reconciliation/
 *     bank-logos.ts), and a bank's icon on a purchase would read as the
 *     vendor.
 *   - Free-mail and ISP mail: a person's own address says nothing about
 *     whom they paid.
 *   - Invoice, e-invoice and mail platforms that send on behalf of others:
 *     an invoice from Hallon sent through Billogram is Hallon's, never
 *     Billogram's.
 *
 * Matched on the registrable domain, exactly or by its main label ("live"
 * covers live.se and live.com) or by a label prefix for a brand that names
 * its sites by suffix ("sparbank" covers sparbankensyd.se).
 */
import { mainLabel, registrableDomain } from './domain'

/** Exact registrable domains. */
const EXACT: ReadonlySet<string> = new Set([
  // Free-mail
  'me.com', 'mac.com', 'icloud.com', 'aol.com', 'msn.com', 'mail.com', 'gmx.com', 'gmx.net', 'gmx.de',
  'yandex.com', 'yandex.ru', 'protonmail.com', 'protonmail.ch', 'proton.me', 'pm.me', 'tutanota.com', 'tuta.io',
  'zoho.eu', 'zohomail.com', 'zohomail.eu', 'mail.ru', 'qq.com', '163.com',
  // ISP mail (the brand's own site is another domain: telia.se, tele2.se)
  'telia.com', 'bredband.net', 'spray.se', 'comhem.se', 'swipnet.se', 'home.se', 'passagen.se', 'glocalnet.net',
  'chello.se', 'tiscali.se', 'algonet.se', 'telia.net', 'tele2.net',
  // Banks without a label rule below
  'lf.se', 'seb.se', 'sebgroup.com', 'dnb.se', 'dnb.no', 'sbab.se', 'icabanken.se',
  // Mail delivery services that send on behalf of others
  'mcsv.net', 'mcdlv.net', 'rsgsv.net', 'mandrillapp.com', 'sparkpostmail.com', 'postmarkapp.com', 'mailjet.com',
  'sendinblue.com', 'brevo.com', 'mailersend.net', 'customeriomail.com', 'intercom-mail.com', 'hubspotemail.net',
  'mailchannels.net', 'mlsend.com', 'exacttarget.com',
  // E-invoice and Peppol access points
  'pagero.com', 'inexchange.se', 'crediflow.se', 'qvalia.com', 'storecove.com', 'basware.com', 'tradeshift.com',
  'peppol.eu', 'peppol.org', 'e-faktura.se', 'efaktura.se', 'svefaktura.se', 'invoiceportal.se', 'zervant.com',
  'billecta.com',
])

/** Main labels excluded under every TLD. */
const LABELS: ReadonlySet<string> = new Set([
  // Skatteverket
  'skatteverket',
  // Free-mail
  'gmail', 'googlemail', 'hotmail', 'outlook', 'live', 'yahoo', 'ymail',
  // Banks and the payment brands lib/reconciliation/bank-logos.ts draws
  'nordea', 'handelsbanken', 'swedbank', 'danskebank', 'danske', 'lansforsakringar', 'avanza', 'nordnet', 'skandia',
  'skandiabanken', 'resursbank', 'resurs', 'marginalen', 'marginalenbank', 'ikanobank', 'northmill', 'santander',
  'landshypotek', 'alandsbanken', 'collector', 'lunar', 'revolut', 'wise', 'transferwise', 'klarna', 'paypal',
  'stripe', 'svea',
  // Invoice and mail platforms that send on behalf of others
  'billogram', 'fortnox', 'visma', 'kivra', 'mailgun', 'sendgrid', 'amazonses', 'sendpulse',
  'e-faktura', 'efaktura', 'peppol',
])

/** Main-label prefixes for brands that name their sites by suffix. */
const LABEL_PREFIXES: readonly string[] = ['sparbank', 'fortnox', 'visma', 'billogram', 'kivra', 'mailgun', 'sendgrid', 'amazonses']

/**
 * Whether a domain (any host; its registrable domain is checked) must never
 * be fetched. An unparseable host counts as excluded: nothing fetches it.
 */
export function isExcludedDomain(host: string | null | undefined): boolean {
  const domain = registrableDomain(host)
  if (!domain) return true
  if (EXACT.has(domain)) return true
  const label = mainLabel(domain)
  if (LABELS.has(label)) return true
  return LABEL_PREFIXES.some((p) => label.startsWith(p))
}
