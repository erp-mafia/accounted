export default {
  rule: 'portal-session-configuration',
  says: 'A Stripe customer portal session opens on a configuration whose plan switch offers exactly the prices checkout sells.',
  home: 'src/lib/stripe/portal-session.ts: createPortalSession',
  why: 'Sessions opened on the default configuration offered the plan list kept by hand in the Stripe Dashboard, still the pre-raise prices, and a customer on 249 a month bought a year at 1 999 instead of 2 388.',
  match: [/billingPortal\.(sessions|configurations)\.create\b/],
  sanctioned: ['lib/stripe/portal-session.ts'],
}
