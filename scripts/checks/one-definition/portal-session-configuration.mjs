export default {
  rule: 'portal-session-configuration',
  says: 'A Stripe customer portal session opens on a configuration whose plan switch offers exactly the prices checkout sells.',
  home: 'src/lib/stripe/portal-session.ts: createPortalSession',
  why: 'Sessions opened on the default configuration offered the plan list kept by hand in the Stripe Dashboard, which can differ from what checkout sells.',
  match: [/billingPortal\.(sessions|configurations)\.create\b/],
  sanctioned: ['lib/stripe/portal-session.ts'],
}
