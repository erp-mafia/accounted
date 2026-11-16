/**
 * Names the command palette finds a page by that are not on its screen: the
 * name a menu row had before the V7 shell renamed it (2026-11-16), and the
 * settings pages people look for by name. Each one joins PAGE_ALIASES
 * (components/common/CommandPalette.tsx), so it moves, hides and gates with
 * the menu like every other alias (components/common/palette-pages.ts): one
 * whose href is a row lends the row its words, the others are entries filed
 * under the area the shell lights for their address.
 *
 * Swedish in every locale, like INBOX_SEARCH_KEYWORDS (lib/inkorg/flag.ts):
 * these are words people type, not text on screen. The English name a row
 * had is a keyword beside the Swedish one. An entry that is shown (a settings
 * page) takes its label from the command_palette.* messages.
 *
 * The palette opens the first hit, in menu order, so a word here must not
 * take Enter from a page that already answers to it:
 *   - "kontoutdrag" stays with Huvudbok alone, not Bankrader;
 *   - the income declaration is named on Fler rapporter, which lists it for
 *     the company's legal form, and not on Bokslut, where the bare word
 *     "deklaration" would leave Moms;
 *   - Kassa och butik does not answer to "Kassarapporter": it would be listed
 *     above the reports for every "rapport". "kassa" finds it.
 */
export interface PaletteWordAlias {
  id: string
  /** The name people type: a row's former menu name, or the page's own name. */
  label: string
  href: string
  /** More words for the same page, space-separated. */
  keywords?: string
}

export const PALETTE_WORD_ALIASES: readonly PaletteWordAlias[] = [
  // Former names of rows that are still in the menu.
  { id: 'transaktioner', label: 'Transaktioner', href: '/transactions', keywords: 'banktransaktioner transactions' },
  { id: 'assistent', label: 'Assistent', href: '/chat', keywords: 'fråga ai assistant' },
  { id: 'viktiga-datum', label: 'Viktiga datum', href: '/deadlines', keywords: 'deadlines förfallodagar important dates' },
  { id: 'wiki', label: 'Wiki', href: '/wiki' },
  { id: 'alla-dokument', label: 'Alla dokument', href: '/arkiv', keywords: 'all documents' },
  { id: 'bolaget', label: 'Bolaget', href: '/bolaget' },
  // The import page also exports (the row was "Importera/Exportera") and is where a move from another system starts.
  { id: 'exportera', label: 'Exportera', href: '/import', keywords: 'sie flytta byta' },
  // Rows the menu no longer has: Årsbokslut is the Bokslut page; the
  // årsredovisning is reached from it and listed under Fler rapporter, where
  // the income declarations (INK2, INK3, NE) are too.
  { id: 'årsbokslut', label: 'Årsbokslut', href: '/bookkeeping/year-end', keywords: 'årsredovisning' },
  { id: 'inkomstdeklaration', label: 'Inkomstdeklaration', href: '/reports', keywords: 'ink2 ink3 ne-bilaga årsredovisning' },
  // Koppla en agent was "API och MCP" under Inställningar.
  { id: 'api', label: 'API och MCP', href: '/settings/api', keywords: 'nyckel nycklar api-nyckel api-nycklar claude chatgpt' },
  // Settings pages by the name their section has. No row in the tree: each is
  // an entry under Inställningar, offered while a company is open.
  { id: 'bank', label: 'Bank', href: '/settings/banking', keywords: 'bankkoppling koppla' },
  { id: 'kopplingar', label: 'Kopplingar', href: '/settings/connections' },
  { id: 'abonnemang', label: 'Abonnemang', href: '/settings/billing', keywords: 'plan pris betalning' },
  { id: 'användare', label: 'Användare', href: '/settings/members', keywords: 'medlemmar bjud in' },
]
