export default {
  rule: 'vat-net-as-filed',
  says: 'The moms a period pays or gets back is the net as filed, every ruta in whole kronor: a surface that states the amount reads buildFiledAmounts, never the öre sum in ruta 49.',
  home: 'src/lib/reports/vat-manual-filing.ts: buildFiledAmounts',
  why: 'The close check said 6 140,10 kr where the momsverifikat booked 6 141, and the MCP review widget still headed the same period 6 140,10 beside a summary of 6 141.',
  match: [
    // rutor.ruta49, r.ruta49, declaration.rutor.ruta49: a read of the öre sum.
    /\.ruta49\b/,
    // const { ruta49 } = rutor: the same read, destructured.
    /\{[^}]*\bruta49\b[^}]*\}\s*=/,
  ],
  sanctioned: ['lib/reports/vat-manual-filing.ts', 'lib/reports/vat-declaration.ts'],
  allowed: {
    'components/reports/VatFiledChangesLine.tsx': 'The change in ruta 49 since a filing, not the amount of a period.',
    'components/reports/lazy-views/VatDeclarationView.tsx': 'Prints the öre sum under the filed net, named as the exact öre.',
    'extensions/general/mcp-server/widgets/vat-review.ts': 'Prints the öre sum under the filed net, named as the exact öre.',
    'lib/measures/definitions.ts': 'The vat_payable measure is the report field rutor.ruta49 by definition; its parity test holds the two equal.',
    'lib/operations/measures.ts': 'Names the report field the vat_payable measure equals.',
    'lib/reports/vat-declaration-checks.ts': 'Checks the stored ruta 49 against its own terms.',
    'lib/reports/vat-eskd-file.ts': 'Reads ruta49 off buildFiledAmounts: the filed net itself.',
    'lib/vat/voucher-vat-impact.ts': 'Builds the ruta 49 change of one voucher.',
  },
}
