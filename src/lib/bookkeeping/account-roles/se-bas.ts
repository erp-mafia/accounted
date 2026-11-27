import type { AccountRole } from './roles'

/**
 * The SE pack's accounts per role: the BAS 2026 accounts the product books
 * on by default (names from lib/bookkeeping/bas-data). SE pack territory in
 * scripts/checks/jurisdiction-welds.mjs: the account numbers are the point
 * of this file, so bas-account-literal does not count them.
 *
 * Complete by type: Sweden answers every role, so adding a role to
 * ./roles.ts does not compile until it has a BAS account here. Each value is
 * the literal the call sites spelled before they asked for the role, so
 * moving a site here changes no booking; __tests__/account-roles.test.ts
 * pins every one.
 */
export const SE_BAS_ACCOUNT_ROLES: Readonly<Record<AccountRole, string>> = Object.freeze({
  /** 1930 Företagskonto. */
  bank: '1930',
  /** 1510 Kundfordringar. */
  accounts_receivable: '1510',
  /** 2440 Leverantörsskulder. */
  accounts_payable: '2440',
  /** 2611 Utgående moms på försäljning inom Sverige, 25 %. */
  output_vat_25: '2611',
  /** 2621 Utgående moms på försäljning inom Sverige, 12 %. */
  output_vat_12: '2621',
  /** 2631 Utgående moms på försäljning inom Sverige, 6 %. */
  output_vat_6: '2631',
  /** 2641 Debiterad ingående moms. */
  input_vat: '2641',
  /** 2650 Redovisningskonto för moms. */
  vat_settlement: '2650',
  /** 1650 Momsfordran. */
  vat_receivable: '1650',
  /** 3740 Öres- och kronutjämning. */
  rounding: '3740',
  /** 2420 Förskott från kunder. */
  customer_advances: '2420',
  /** 6570 Bankkostnader. */
  payment_fees: '6570',
  /** 3960 Valutakursvinster på fordringar och skulder av rörelsekaraktär. */
  operating_fx_gain: '3960',
  /** 7960 Valutakursförluster på fordringar och skulder av rörelsekaraktär. */
  operating_fx_loss: '7960',
  /** 2645 Beräknad ingående moms på förvärv från utlandet. */
  input_vat_reverse_charge_foreign: '2645',
  /** 2647 Ingående moms omvänd betalningsskyldighet varor och tjänster i Sverige. */
  input_vat_reverse_charge_domestic: '2647',
  /** 1513 Kundfordringar: delad faktura (ROT/RUT, SE-only). */
  rot_rut_receivable: '1513',
  /** 3106 Försäljning varor till annat EU-land, momspliktig. */
  oss_sales: '3106',
  /** 2670 Utgående moms på försäljning inom EU, OSS. */
  oss_output_vat: '2670',
  /** 3105 Försäljning varor till land utanför EU. */
  export_goods_sales: '3105',
  /** 7323 Skattefria traktamenten, utlandet. */
  foreign_per_diem_tax_free: '7323',
  /** 7324 Skattepliktiga traktamenten, utlandet. */
  foreign_per_diem_taxable: '7324',
  /** 8313 Ränteintäkter från kortfristiga fordringar. */
  late_payment_interest_income: '8313',
})
