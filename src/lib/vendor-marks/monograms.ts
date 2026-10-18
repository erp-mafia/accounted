/**
 * Brand-coloured monograms: the vendor's initials on its own colour, for
 * vendors Simple Icons has no CC0 mark for (most Swedish ones, and the
 * global ones whose owners asked Simple Icons to remove theirs). No logo
 * shapes: only letters and a colour, both drawn by the app.
 *
 * Where each colour comes from:
 *   - the vendor's own site, read 2026-10-17 (theme colour, tile colour,
 *     manifest or logo file): ICA, OKQ8, Tele2, Tre, Biltema, Coop, Apoteket,
 *     Byggmax, Preem, SJ;
 *   - the Inkorg prototype (underlagsflodet.html): Telia, Vattenfall, Clas
 *     Ohlson, Circle K, Kjell & Company, Folksam, Securitas, Kivra, Peppol,
 *     Billo, Espresso House;
 *   - the brand's published primary colour: PostNord, OpenAI, Amazon, AWS,
 *     Adobe, Slack, Canva, LinkedIn, Microsoft, Bolt.
 *
 * Every monogram ships inside the app: nothing is fetched at runtime.
 */

export interface VendorMonogramData {
  /** The vendor's name, as a person reads it. */
  title: string
  /** One to three characters. */
  initials: string
  /** Background, six hex digits without the #. */
  bg: string
  /** Text colour, six hex digits without the #. */
  fg: string
}

export const VENDOR_MONOGRAMS = {
  // Sweden
  telia: { title: 'Telia', initials: 'T', bg: '990AE3', fg: 'FFFFFF' },
  tele2: { title: 'Tele2', initials: 'T2', bg: '001425', fg: 'FFFFFF' },
  tre: { title: 'Tre', initials: '3', bg: 'FF5C00', fg: 'FFFFFF' },
  vattenfall: { title: 'Vattenfall', initials: 'V', bg: 'FFDA00', fg: '1B1A18' },
  clasohlson: { title: 'Clas Ohlson', initials: 'CO', bg: '0A5AA6', fg: 'FFFFFF' },
  circlek: { title: 'Circle K', initials: 'K', bg: 'DA291C', fg: 'FFFFFF' },
  kjell: { title: 'Kjell & Company', initials: 'K&C', bg: '1C1C1C', fg: 'FFFFFF' },
  folksam: { title: 'Folksam', initials: 'F', bg: '00539B', fg: 'FFFFFF' },
  securitas: { title: 'Securitas', initials: 'S', bg: 'E2001A', fg: 'FFFFFF' },
  preem: { title: 'Preem', initials: 'P', bg: '006341', fg: 'FFFFFF' },
  okq8: { title: 'OKQ8', initials: 'Q8', bg: '20419A', fg: 'FFFFFF' },
  ica: { title: 'ICA', initials: 'ICA', bg: 'EB1F07', fg: 'FFFFFF' },
  coop: { title: 'Coop', initials: 'C', bg: '00AA46', fg: 'FFFFFF' },
  postnord: { title: 'PostNord', initials: 'PN', bg: '00A0D6', fg: 'FFFFFF' },
  sj: { title: 'SJ', initials: 'SJ', bg: '00AB3B', fg: 'FFFFFF' },
  biltema: { title: 'Biltema', initials: 'B', bg: '0071B9', fg: 'FFFFFF' },
  byggmax: { title: 'Byggmax', initials: 'B', bg: 'EB001E', fg: 'FFFFFF' },
  apoteket: { title: 'Apoteket', initials: 'A', bg: '42AE29', fg: '0B1F14' },
  espressohouse: { title: 'Espresso House', initials: 'EH', bg: '6D1F2F', fg: 'FFFFFF' },
  kivra: { title: 'Kivra', initials: 'K', bg: '00A660', fg: 'FFFFFF' },
  peppol: { title: 'Peppol', initials: 'P', bg: '1F4E8C', fg: 'FFFFFF' },
  billo: { title: 'Billo', initials: 'B', bg: '2B2D42', fg: 'FFFFFF' },
  // Global vendors without a CC0 mark
  openai: { title: 'OpenAI', initials: 'O', bg: '000000', fg: 'FFFFFF' },
  amazon: { title: 'Amazon', initials: 'A', bg: 'FF9900', fg: '232F3E' },
  aws: { title: 'Amazon Web Services', initials: 'AWS', bg: '232F3E', fg: 'FF9900' },
  adobe: { title: 'Adobe', initials: 'A', bg: 'FA0F00', fg: 'FFFFFF' },
  slack: { title: 'Slack', initials: 'S', bg: '4A154B', fg: 'FFFFFF' },
  canva: { title: 'Canva', initials: 'C', bg: '7D2AE8', fg: 'FFFFFF' },
  linkedin: { title: 'LinkedIn', initials: 'Li', bg: '0A66C2', fg: 'FFFFFF' },
  microsoft: { title: 'Microsoft', initials: 'M', bg: '0078D4', fg: 'FFFFFF' },
  bolt: { title: 'Bolt', initials: 'B', bg: '34D186', fg: '0B1F14' },
} as const satisfies Record<string, VendorMonogramData>

export type VendorMonogramKey = keyof typeof VENDOR_MONOGRAMS
