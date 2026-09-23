/**
 * Demo articles (artikelregister) for the sandbox company.
 *
 * /articles renders the Package empty state in a fresh sandbox, which hides an
 * entire surface: reusable invoice-line presets are how most users actually
 * build a faktura. Five rows are enough to show the register's shape (numbering,
 * vara vs tjanst, unit, price excl VAT, VAT rate, active flag) without turning
 * the demo into a catalogue.
 *
 * Modelled on a one-person Swedish IT/design consultancy (enskild firma), which
 * is what the rest of the seed portrays: hourly work on löpande räkning, one
 * fixed-price package, one rebilled licence, and one printed book.
 *
 * VAT rates are law, not decoration:
 *   - Consulting and design services, the fixed-price package and the rebilled
 *     software licence are all ordinary 25 % supplies (ML 6 kap.).
 *   - The printed handbook is 6 %: böcker, broschyrer och häften carry the
 *     reduced rate (ML 9 kap., the 6 % rates sit in §§ 8-15). No other article
 *     here qualifies for a reduced rate, so the rest stay at 25 %.
 *
 * revenue_account is left NULL on every row on purpose: NULL means "derive the
 * revenue account from the VAT treatment at line-create time", which is the
 * behaviour we want to demonstrate. Pinning an override would freeze a 25 %
 * account onto the 6 % book line and misreport ruta 05.
 *
 * Every row sets every optional column explicitly (null where empty). PostgREST
 * normalizes columns across the rows of a bulk insert, so a key present on one
 * row and absent on another is sent as NULL rather than falling through to the
 * schema default: the same gotcha documented on the journal lines in route.ts.
 */

export interface SandboxArticlesInput {
  userId: string
  companyId: string
}

export function buildSandboxArticles({ userId, companyId }: SandboxArticlesInput) {
  const base = { user_id: userId, company_id: companyId, currency: 'SEK', active: true }

  return [
    {
      ...base,
      article_number: 'A-001',
      name: 'Konsulttimme, systemutveckling',
      name_en: 'Consulting hour, software development',
      type: 'tjanst',
      unit: 'tim',
      price_excl_vat: 1150,
      vat_rate: 25,
      revenue_account: null,
      cost_price: null,
      ean: null,
      housework_type: null,
      notes: 'Löpande räkning. Faktureras månadsvis i efterskott.',
    },
    {
      ...base,
      article_number: 'A-002',
      name: 'Konsulttimme, UX och gränssnittsdesign',
      name_en: 'Consulting hour, UX and interface design',
      type: 'tjanst',
      unit: 'tim',
      price_excl_vat: 995,
      vat_rate: 25,
      revenue_account: null,
      cost_price: null,
      ean: null,
      housework_type: null,
      notes: 'Löpande räkning. Faktureras månadsvis i efterskott.',
    },
    {
      ...base,
      article_number: 'A-003',
      name: 'Startpaket webbplats, fast pris',
      name_en: 'Website starter package, fixed price',
      type: 'tjanst',
      unit: 'st',
      price_excl_vat: 38000,
      vat_rate: 25,
      revenue_account: null,
      cost_price: null,
      ean: null,
      housework_type: null,
      notes: 'Fast pris: design, uppsättning och överlämning. Halva beloppet vid start.',
    },
    {
      ...base,
      article_number: 'A-004',
      name: 'Vidarefakturerad licens, designverktyg (1 plats, 12 mån)',
      name_en: 'Rebilled licence, design tool (1 seat, 12 months)',
      // A resold licence is a vara in the register's sense: a unit the customer
      // buys, not time we spend. cost_price is display/margin only and is never
      // posted to the ledger.
      type: 'vara',
      unit: 'st',
      price_excl_vat: 5400,
      vat_rate: 25,
      revenue_account: null,
      cost_price: 4860,
      ean: null,
      housework_type: null,
      notes: 'Inköpspris plus påslag. Faktureras när licensen förnyas.',
    },
    {
      ...base,
      article_number: 'A-005',
      name: 'Handbok: Designsystem i praktiken (tryckt)',
      name_en: 'Handbook: Design systems in practice (print)',
      type: 'vara',
      unit: 'st',
      price_excl_vat: 320,
      vat_rate: 6,
      revenue_account: null,
      cost_price: 118,
      ean: null,
      housework_type: null,
      // The one reduced rate in the register, and the reason it is here: a
      // printed book is 6 % under ML 9 kap., so the demo shows a mixed-rate
      // register instead of a wall of 25 %. The note stays at chapter level:
      // a paragraph-precise citation in demo copy is a liability if it drifts.
      notes: 'Tryckt bok: 6 % moms enligt ML 9 kap.',
    },
  ]
}
