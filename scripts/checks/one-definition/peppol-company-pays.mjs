export default {
  rule: 'peppol-company-pays',
  says: 'A company may have Peppol while it pays: an unexpired grant that is not the seeded trial (a Stripe subscription that is active, past due or trialing with a card, a manual or comp grant, a byrå agreement on its team), and never while archived.',
  home: 'src/lib/invoices/peppol-plan-rule.ts: peppolPaidCompanyIds',
  why: 'The daily Peppol report judged "pays" from the Stripe subscription status alone while access was granted by hand, so a company covered by a byrå agreement read as not paying and the report contradicted the grant.',
  match: [
    /statusGrantsAccess\(/,
    /from\(\s*['"]company_subscriptions['"]\s*\)/,
  ],
  sanctioned: ['lib/invoices/peppol-plan-rule.ts'],
  scan: ['lib/invoices/peppol', 'app/api/peppol', 'app/api/settings/peppol', 'components/settings/Peppol'],
}
