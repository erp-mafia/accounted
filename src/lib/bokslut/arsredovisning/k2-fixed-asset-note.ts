/**
 * The K2 note on immateriella and materiella anläggningstillgångar (ÅRL 5
 * kap. 8 §, BFNAR 2016:10 punkt 18.10) as data: one table per balance sheet
 * post, each a set of blocks (anskaffningsvärden, avskrivningar,
 * nedskrivningar) that roll the year forward from the opening to the closing
 * balance. Both documents print these rows: the PDF as text (the note body),
 * the iXBRL as a table with every figure tagged
 * (ixbrl/document/fixed-asset-note.ts).
 *
 * The rows, their labels and their order are the K2 taxonomy's (se-gen-base,
 * the note of each post in the element list of version 2024-09-12), which
 * Bokföringsnämnden's example 18 c and Bolagsverket's test criteria follow.
 * A row's amount is positive in the direction the taxonomy's standard label
 * names ("Ökning ...", "Minskning ...", "Periodens avskrivningar"); `effect`
 * says what that does to the block's balance.
 *
 * Every figure has one source:
 *   - the anläggningsregister (anlaggningstillgangar-note.ts), per post:
 *     the opening balances, the year's new assets on the row of how they
 *     came in (Asset.acquisition_type: Inköp, Rörelseförvärv, Fusion,
 *     Omklassificeringar), försäljningar/utrangeringar, the year's
 *     avskrivningar and nedskrivningar. The avskrivningar an asset carried
 *     when it came in by fusion or omklassificering (its opening amount) are
 *     the Fusion and Omklassificeringar rows of the avskrivningar block, so
 *     next year's opening balance holds them without anyone restating them;
 *   - the ledger's write-down accounts, for what they hold beyond the
 *     register (a nedskrivning booked by hand, taken over, or from before
 *     Accounted): the table of a post shows every nedskrivning of the post,
 *     so its opening balance is last year's closing whatever the source;
 *   - the rows neither can tell apart (FIXED_ASSET_STATED_ROWS), which the
 *     user states for the year (arsredovisning_narratives.fixed_asset_note_rows):
 *     omräkningsdifferenser, and which part of what the write-down accounts
 *     moved beyond the register came by fusion, försäljning or utrangering,
 *     omklassificering or omräkning instead of being the year's nedskrivning
 *     or återföring. An omräkningsdifferens stays in the post's balances
 *     until a later row takes it out, so a year opens with what the years
 *     before it stated (carriedFromEarlierYears).
 *
 * The note must tie to the books post by post, at the end of the year and at
 * its start (fixedAssetPostTieOut): build-data checks it, and a stated row
 * that breaks a tie blocks the document.
 *
 * Not here: uppskrivningar (K2 allows them on byggnader och mark only, and
 * they need the uppskrivningsfond disclosures of ÅRL 5 kap. 8 § första
 * stycket 6 and 11 § beside them), and the posts whose note has other rows
 * (pågående nyanläggningar and förskott). A register asset booked on an
 * account of such a post still gets a table, under the post's name and
 * untagged: its rows are not that post's rows in the taxonomy.
 */
import { roundWhole } from '@/lib/bokslut/ixbrl/whole-kronor'
import { roundOre } from '@/lib/money'
import {
  buildRollforward,
  CATEGORY_LABELS,
  emptyRollforward,
  type AnlaggningAsset,
  type CategoryRollforward,
} from './anlaggningstillgangar-note'
import { formatNoteKronor, formatPdfKronor } from './pdf-format'

export type FixedAssetBlockKey = 'cost' | 'depreciation' | 'impairment'

/**
 * The balance sheet posts whose note the K2 taxonomy defines with these
 * rows, in balance sheet order. A stated row names one of them.
 */
export const K2_FIXED_ASSET_NOTE_POSTS = [
  'KoncessionerPatentLicenserVarumarkenLiknandeRattigheter',
  'HyresratterLiknandeRattigheter',
  'Goodwill',
  'ByggnaderMark',
  'MaskinerAndraTekniskaAnlaggningar',
  'InventarierVerktygInstallationer',
  'ForbattringsutgifterAnnansFastighet',
  'OvrigaMateriellaAnlaggningstillgangar',
] as const

export type K2FixedAssetNotePost = (typeof K2_FIXED_ASSET_NOTE_POSTS)[number]

/**
 * Goodwill arises in a rörelseförvärv, never by a purchase of its own: the
 * taxonomy has no Inköp row for it, so what the register holds as bought
 * prints as Rörelseförvärv.
 */
const NO_PURCHASE_ROW_POST: K2FixedAssetNotePost = 'Goodwill'

/**
 * The rows the user states, as `block.row`. Amounts are whole kronor and
 * follow the row's standard label: an omräkningsdifferens of
 * anskaffningsvärden is positive when it raises them ("Ökning (minskning)");
 * one of avskrivningar or nedskrivningar and an omklassificering of
 * nedskrivningar are positive when they lower the accumulated amount
 * ("Minskning (ökning)"). The nedskrivning rows say where a movement on the
 * post's write-down accounts beyond the register came from.
 */
export const FIXED_ASSET_STATED_ROWS = [
  'cost.omrakningsdifferenser',
  'depreciation.omrakningsdifferenser',
  'impairment.fusion',
  'impairment.forsaljningar',
  'impairment.omklassificeringar',
  'impairment.omrakningsdifferenser',
] as const

export type FixedAssetStatedRow = (typeof FIXED_ASSET_STATED_ROWS)[number]

/**
 * The stated rows that take no negative amount, each with what to tell the
 * user. Their standard labels name one direction: nedskrivningar taken over
 * in a fusion can only add (the taxonomy's documentation of the row: "I K2
 * endast ökning av ackumulerade nedskrivningar"), and "Återförda
 * nedskrivningar i samband med försäljningar eller utrangeringar" has no
 * reverse.
 */
const NEVER_NEGATIVE_ROWS: Partial<Record<FixedAssetStatedRow, string>> = {
  'impairment.fusion':
    'Nedskrivningar som övertagits genom fusion kan bara öka de ackumulerade nedskrivningarna: ange ett positivt belopp.',
  'impairment.forsaljningar':
    'Nedskrivningar som lämnat posten genom försäljning eller utrangering anges som ett positivt belopp.',
}

/** Why a stated amount cannot stand on its row, or null when it can. */
export function statedRowIssue(row: FixedAssetStatedRow, amount: number): string | null {
  if (!Number.isInteger(amount)) return 'Ange beloppet i hela kronor.'
  if (amount < 0) return NEVER_NEGATIVE_ROWS[row] ?? null
  return null
}

/** The year's stated rows per post (arsredovisning_narratives.fixed_asset_note_rows). */
export type FixedAssetNoteRows = Partial<Record<K2FixedAssetNotePost, Partial<Record<FixedAssetStatedRow, number>>>>

export interface FixedAssetNoteRow {
  /** `block.row`, stable: the iXBRL concept is resolved from it. */
  key: string
  label: string
  /** Kronor, positive in the direction the taxonomy's standard label names. */
  amount: number
  /** What a positive amount does to the block's balance: 1 raises it, -1 lowers it. */
  effect: 1 | -1
  kind: 'opening' | 'movement' | 'closing'
}

export interface FixedAssetNoteBlock {
  key: FixedAssetBlockKey
  /**
   * Accumulated avskrivningar and nedskrivningar reduce the redovisat värde:
   * their figures print with the opposite sign.
   */
  contra: boolean
  rows: FixedAssetNoteRow[]
}

export interface FixedAssetNoteTable {
  /** The balance sheet post (K2 concept); null when the asset's account is in no post. */
  post: string | null
  label: string
  blocks: FixedAssetNoteBlock[]
  /** Utgående redovisat värde: anskaffningsvärden less avskrivningar and nedskrivningar. */
  carrying: number
}

interface RowDef {
  row: string
  label: string
  effect: 1 | -1
}

/**
 * Blocks and rows in print order, labelled with the taxonomy's row labels
 * and with the direction of each row's standard label (both pinned against
 * the registry in ixbrl/__tests__/fixed-asset-note.test.ts).
 */
const BLOCKS: ReadonlyArray<{
  key: FixedAssetBlockKey
  contra: boolean
  opening: string
  closing: string
  rows: readonly RowDef[]
}> = [
  {
    key: 'cost',
    contra: false,
    opening: 'Ingående anskaffningsvärden',
    closing: 'Utgående anskaffningsvärden',
    rows: [
      { row: 'inkop', label: 'Inköp', effect: 1 },
      { row: 'rorelseforvarv', label: 'Rörelseförvärv', effect: 1 },
      { row: 'fusion', label: 'Fusion', effect: 1 },
      { row: 'forsaljningar', label: 'Försäljningar/utrangeringar', effect: -1 },
      { row: 'omklassificeringar', label: 'Omklassificeringar', effect: 1 },
      { row: 'omrakningsdifferenser', label: 'Omräkningsdifferenser', effect: 1 },
    ],
  },
  {
    key: 'depreciation',
    contra: true,
    opening: 'Ingående avskrivningar',
    closing: 'Utgående avskrivningar',
    rows: [
      { row: 'fusion', label: 'Fusion', effect: 1 },
      { row: 'forsaljningar', label: 'Försäljningar/utrangeringar', effect: -1 },
      { row: 'omklassificeringar', label: 'Omklassificeringar', effect: -1 },
      { row: 'arets', label: 'Årets avskrivningar', effect: 1 },
      { row: 'omrakningsdifferenser', label: 'Omräkningsdifferenser', effect: -1 },
    ],
  },
  {
    key: 'impairment',
    contra: true,
    opening: 'Ingående nedskrivningar',
    closing: 'Utgående nedskrivningar',
    rows: [
      { row: 'fusion', label: 'Fusion', effect: 1 },
      { row: 'forsaljningar', label: 'Försäljningar/utrangeringar', effect: -1 },
      { row: 'aterforda', label: 'Återförda nedskrivningar', effect: -1 },
      { row: 'omklassificeringar', label: 'Omklassificeringar', effect: -1 },
      { row: 'arets', label: 'Årets nedskrivningar', effect: 1 },
      { row: 'omrakningsdifferenser', label: 'Omräkningsdifferenser', effect: -1 },
    ],
  },
]

export const FIXED_ASSET_CARRYING_LABEL = 'Redovisat värde'

function isNotePost(value: string): value is K2FixedAssetNotePost {
  return (K2_FIXED_ASSET_NOTE_POSTS as readonly string[]).includes(value)
}

function isStatedRow(value: string): value is FixedAssetStatedRow {
  return (FIXED_ASSET_STATED_ROWS as readonly string[]).includes(value)
}

/** What a positive amount on the row does to its block's balance. */
function effectOf(row: FixedAssetStatedRow): 1 | -1 {
  const [block, name] = row.split('.')
  const def = BLOCKS.find((candidate) => candidate.key === block)?.rows.find((candidate) => candidate.row === name)
  if (!def) throw new Error(`Unknown row of the anläggningstillgångar note: ${row}`)
  return def.effect
}

/**
 * Keep only known posts and rows with an amount other than zero, in whole
 * kronor. An amount its row cannot carry (statedRowIssue) is dropped; the
 * API refuses it before it is stored.
 */
export function normalizeFixedAssetNoteRows(value: unknown): FixedAssetNoteRows {
  const result: FixedAssetNoteRows = {}
  if (!value || typeof value !== 'object' || Array.isArray(value)) return result
  for (const [post, rows] of Object.entries(value as Record<string, unknown>)) {
    if (!isNotePost(post) || !rows || typeof rows !== 'object' || Array.isArray(rows)) continue
    const kept: Partial<Record<FixedAssetStatedRow, number>> = {}
    for (const [row, amount] of Object.entries(rows as Record<string, unknown>)) {
      if (!isStatedRow(row)) continue
      if (typeof amount !== 'number' || !Number.isFinite(amount)) continue
      const rounded = roundWhole(amount)
      if (rounded !== 0 && statedRowIssue(row, rounded) === null) kept[row] = rounded
    }
    if (Object.keys(kept).length > 0) result[post] = kept
  }
  return result
}

/** What a save sends: a row with an amount, a row or a post to clear (null), or null for everything. */
export type FixedAssetNoteRowsPatch = Record<string, Record<string, number | null> | null> | null

/**
 * The stored rows with a save applied, row by row: a row sent replaces that
 * row, a null row removes it, a null post removes the post's rows, null
 * removes everything, and what is not named stays. A user or an agent states
 * one row at a time, so a save must never drop the rows it did not repeat.
 */
export function mergeFixedAssetNoteRows(stored: unknown, sent: FixedAssetNoteRowsPatch): FixedAssetNoteRows {
  if (sent === null) return {}
  const merged: Record<string, Record<string, number>> = {}
  for (const [post, rows] of Object.entries(normalizeFixedAssetNoteRows(stored))) merged[post] = { ...rows }
  for (const [post, rows] of Object.entries(sent)) {
    if (rows === null || rows === undefined) {
      delete merged[post]
      continue
    }
    const next = { ...(merged[post] ?? {}) }
    for (const [row, amount] of Object.entries(rows)) {
      if (amount === null || amount === undefined) delete next[row]
      else next[row] = amount
    }
    merged[post] = next
  }
  return normalizeFixedAssetNoteRows(merged)
}

/** What the earlier years' stated rows left in a post's opening balances. */
export interface CarriedOpening {
  /** In the ingående anskaffningsvärden beyond the register's. */
  cost: number
  /** In the ingående avskrivningar beyond the register's. */
  depreciation: number
}

const NOTHING_CARRIED: CarriedOpening = { cost: 0, depreciation: 0 }

/**
 * What the stated rows of the years before left in each post's opening
 * balances, oldest year first. An omräkningsdifferens changes the booked
 * anskaffningsvärden or avskrivningar without the register knowing, and it
 * stays on the post's accounts: every later year opens with it, until a
 * stated row takes it out again (when the asset is sold, the opposite
 * amount). The nedskrivning rows need no carrying: they describe movements
 * on the write-down accounts, whose balance the ledger holds.
 */
export function carriedFromEarlierYears(
  earlierYears: readonly FixedAssetNoteRows[],
): Map<K2FixedAssetNotePost, CarriedOpening> {
  const carried = new Map<K2FixedAssetNotePost, CarriedOpening>()
  for (const year of earlierYears) {
    for (const post of K2_FIXED_ASSET_NOTE_POSTS) {
      const stated = year[post]
      if (!stated) continue
      const before = carried.get(post) ?? NOTHING_CARRIED
      carried.set(post, {
        cost: roundOre(before.cost + effectOf('cost.omrakningsdifferenser') * (stated['cost.omrakningsdifferenser'] ?? 0)),
        depreciation: roundOre(
          before.depreciation + effectOf('depreciation.omrakningsdifferenser') * (stated['depreciation.omrakningsdifferenser'] ?? 0),
        ),
      })
    }
  }
  for (const [post, amounts] of carried) {
    if (amounts.cost === 0 && amounts.depreciation === 0) carried.delete(post)
  }
  return carried
}

/** What a post's write-down accounts hold beyond the register (ledger-fixed-asset-notes.ts), positive amounts. */
export interface WriteDownsOutsideRegister {
  opening: number
  written: number
  released: number
}

const NOTHING_OUTSIDE: WriteDownsOutsideRegister = { opening: 0, written: 0, released: 0 }

/**
 * What the stated nedskrivning rows of a post do to its accumulated
 * nedskrivningar in the year, gross: `increase` raises them, `decrease`
 * lowers them, both positive.
 */
function statedImpairment(stated: Partial<Record<FixedAssetStatedRow, number>>): { increase: number; decrease: number } {
  let increase = 0
  let decrease = 0
  for (const row of FIXED_ASSET_STATED_ROWS) {
    if (!row.startsWith('impairment.')) continue
    const effect = effectOf(row) * (stated[row] ?? 0)
    if (effect > 0) increase = roundOre(increase + effect)
    else decrease = roundOre(decrease - effect)
  }
  return { increase, decrease }
}

/**
 * A stated nedskrivning row relabels a movement on the post's write-down
 * accounts beyond the register. The rows that raise the nedskrivningar
 * therefore cannot exceed what those accounts were credited beyond the
 * register, nor the rows that lower them what they were debited. The krona
 * the rows are stated in covers the rounding of what is booked (the accounts
 * are in öre); with nothing booked in a direction, no row in it stands. Two
 * rows that are both too large by the same amount would otherwise cancel in
 * the closing balance and pass the tie.
 */
export function statedWriteDownIssues(
  stated: FixedAssetNoteRows,
  outsideWriteDowns: ReadonlyMap<string, WriteDownsOutsideRegister> | undefined,
  labelOfPost: (post: string) => string,
): string[] {
  const issues: string[] = []
  for (const post of K2_FIXED_ASSET_NOTE_POSTS) {
    const rows = stated[post]
    if (!rows) continue
    const { increase, decrease } = statedImpairment(rows)
    const outside = outsideWriteDowns?.get(post) ?? NOTHING_OUTSIDE
    const label = labelOfPost(post)
    const unbooked = (statedAmount: number, booked: number) => statedAmount > 0 && (booked < 0.005 || statedAmount - booked > 1)
    if (unbooked(increase, outside.written)) {
      issues.push(
        `Anläggningsnoten för ${label}: de angivna raderna ökar nedskrivningarna med ${formatPdfKronor(increase)} kr, men postens nedskrivningskonton har krediterats ${formatPdfKronor(outside.written)} kr utöver anläggningsregistret under året. En angiven nedskrivningsrad måste vara bokförd på postens nedskrivningskonton.`,
      )
    }
    if (unbooked(decrease, outside.released)) {
      issues.push(
        `Anläggningsnoten för ${label}: de angivna raderna minskar nedskrivningarna med ${formatPdfKronor(decrease)} kr, men postens nedskrivningskonton har debiterats ${formatPdfKronor(outside.released)} kr utöver anläggningsregistret under året. En angiven nedskrivningsrad måste vara bokförd på postens nedskrivningskonton.`,
      )
    }
  }
  return issues
}

/** What a post's accounts moved in the year, gross (grossMovementsByPost in ledger-fixed-asset-notes.ts). */
export interface GrossMovement {
  cost: number
  /** Null when the accumulated avskrivningar cannot be told from the nedskrivningar on the post's accounts. */
  depreciation: number | null
}

/**
 * A stated omräkningsdifferens must be on the post's accounts, block by
 * block: what the anskaffningskonton moved in the year beyond the rows the
 * register fills is the stated difference of the anskaffningsvärden, and
 * likewise for the accumulated avskrivningar (within the krona the rows are
 * stated in). The tie of the post's value cannot see it: one row in each
 * block of the same amount, neither of them booked, leaves the redovisat
 * värde where it was. Meant for the posts that tie: on one that does not,
 * the tie-out has already named the difference, and this would name it again.
 */
export function statedTranslationIssues(
  tables: readonly FixedAssetNoteTable[],
  stated: FixedAssetNoteRows,
  grossMovements: ReadonlyMap<string, GrossMovement>,
): string[] {
  const issues: string[] = []
  for (const table of tables) {
    if (table.post === null || !isNotePost(table.post)) continue
    const rows = stated[table.post] ?? {}
    const gross = grossMovements.get(table.post) ?? { cost: 0, depreciation: 0 }
    // What the register's rows of a block did to its balance in the year.
    const registerMoved = (key: FixedAssetBlockKey, statedRow: FixedAssetStatedRow): number =>
      roundOre(
        (table.blocks.find((block) => block.key === key)?.rows ?? [])
          .filter((row) => row.kind === 'movement' && row.key !== statedRow)
          .reduce((sum, row) => sum + row.effect * row.amount, 0),
      )

    const cost = rows['cost.omrakningsdifferenser'] ?? 0
    if (cost !== 0) {
      const beyond = roundOre(gross.cost - registerMoved('cost', 'cost.omrakningsdifferenser'))
      if (Math.abs(beyond - effectOf('cost.omrakningsdifferenser') * cost) > 1) {
        issues.push(
          `Anläggningsnoten för ${table.label}: omräkningsdifferensen i anskaffningsvärdena är angiven till ${signedKronor(cost)} kr, men postens anskaffningskonton har under året ändrats med ${signedKronor(beyond)} kr utöver anläggningsregistret. En angiven omräkningsdifferens måste vara bokförd på postens konton.`,
        )
      }
    }

    const depreciation = rows['depreciation.omrakningsdifferenser'] ?? 0
    if (depreciation !== 0 && gross.depreciation !== null) {
      const beyond = roundOre(gross.depreciation - registerMoved('depreciation', 'depreciation.omrakningsdifferenser'))
      if (Math.abs(beyond - effectOf('depreciation.omrakningsdifferenser') * depreciation) > 1) {
        issues.push(
          `Anläggningsnoten för ${table.label}: omräkningsdifferensen i avskrivningarna är angiven till ${signedKronor(depreciation)} kr (ett positivt belopp minskar de ackumulerade avskrivningarna), men postens konton för ackumulerade avskrivningar har under året ändrats med ${signedKronor(beyond)} kr utöver anläggningsregistret (ett positivt belopp ökar dem). En angiven omräkningsdifferens måste vara bokförd på postens konton.`,
        )
      }
    }
  }
  return issues
}

/**
 * What a post's write-down accounts were debited beyond the register, and no
 * stated row accounts for, prints as återförda nedskrivningar. The same debit
 * is booked when a written-down asset is sold or scrapped, or leaves the post
 * by omklassificering, and only the user knows which: the amount and the rows
 * are named, so the row it prints on is a choice and not a default nobody saw.
 * One notice per post with a table; nothing within the krona the rows are
 * stated in.
 */
export function unstatedWriteDownReleases(
  tables: readonly FixedAssetNoteTable[],
  stated: FixedAssetNoteRows,
  outsideWriteDowns: ReadonlyMap<string, WriteDownsOutsideRegister> | undefined,
): string[] {
  const notices: string[] = []
  for (const table of tables) {
    if (table.post === null || !isNotePost(table.post)) continue
    const outside = outsideWriteDowns?.get(table.post)
    if (!outside) continue
    const released = roundOre(outside.released - statedImpairment(stated[table.post] ?? {}).decrease)
    if (released <= 1) continue
    notices.push(
      `Nedskrivningar utanför anläggningsregistret, ${table.label}: postens nedskrivningskonton har debiterats ${formatPdfKronor(released)} kr under året utöver registret, och noten visar beloppet som återförda nedskrivningar. Hör det till en tillgång som sålts eller utrangerats, eller har det lämnat posten genom omklassificering, anges det på den raden i noten i stället. Är det en återföring behöver inget göras.`,
    )
  }
  return notices
}

function buildTable(
  post: string | null,
  label: string,
  register: CategoryRollforward,
  stated: Partial<Record<FixedAssetStatedRow, number>>,
  outside: WriteDownsOutsideRegister,
  carried: CarriedOpening,
): FixedAssetNoteTable {
  const s = (row: FixedAssetStatedRow) => stated[row] ?? 0
  // The year's new assets, each on the row of how it came in. Goodwill has
  // no Inköp row: what the register holds as bought is a rörelseförvärv.
  const cameIn = register.tillkommandePerSatt
  const noPurchaseRow = post === NO_PURCHASE_ROW_POST
  // What the new assets had been depreciated before they came onto these
  // books (an asset's opening amount). Taken over in a fusion or with an
  // omklassificering it is that row of the avskrivningar block; on an asset
  // bought in the year it is the part of the year's avskrivningar that a
  // previous system booked.
  const cameWith = register.overtagnaAck

  // The nedskrivningar the write-down accounts hold beyond the register are
  // the post's too. A stated nedskrivning row says which part of what those
  // accounts moved came by fusion, försäljning, omklassificering or
  // omräkning: it is taken out of the year's nedskrivningar and återföringar,
  // where the movement otherwise shows. Rows that exceed what the accounts
  // moved are refused before the document can be locked
  // (statedWriteDownIssues).
  const statedWriteDowns = statedImpairment(stated)
  const writtenOutside = Math.max(0, roundOre(outside.written - statedWriteDowns.increase))
  const releasedOutside = Math.max(0, roundOre(outside.released - statedWriteDowns.decrease))

  // A row is the register's or the ledger's where they know it, else the stated one.
  const known: Record<string, number> = {
    'cost.opening': register.ibAnskaffning + carried.cost,
    'cost.inkop': noPurchaseRow ? 0 : cameIn.purchase,
    'cost.rorelseforvarv': cameIn.business_acquisition + (noPurchaseRow ? cameIn.purchase : 0),
    'cost.fusion': cameIn.merger,
    'cost.forsaljningar': register.avgaende,
    'cost.omklassificeringar': cameIn.reclassification,
    'depreciation.opening': register.ibAck + carried.depreciation,
    'depreciation.fusion': cameWith.merger,
    'depreciation.forsaljningar': register.avgaendeAck,
    // "Minskning (ökning)": what came in with the asset raises the accumulated amount.
    'depreciation.omklassificeringar': -cameWith.reclassification,
    'depreciation.arets': register.aretsAvskrivning + cameWith.purchase + cameWith.business_acquisition,
    'impairment.opening': register.ibNed + outside.opening,
    // The register's disposals, and what left the write-down accounts beyond it the same way.
    'impairment.forsaljningar': register.avgaendeNed + s('impairment.forsaljningar'),
    'impairment.aterforda': register.aterfordaNed + releasedOutside,
    'impairment.arets': register.aretsNed + writtenOutside,
  }
  const value = (key: string): number => roundOre(known[key] ?? (isStatedRow(key) ? s(key) : 0))

  const closing: Record<FixedAssetBlockKey, number> = { cost: 0, depreciation: 0, impairment: 0 }
  const blocks: FixedAssetNoteBlock[] = []
  for (const def of BLOCKS) {
    const opening = value(`${def.key}.opening`)
    const movements = def.rows.map((row) => ({
      key: `${def.key}.${row.row}`,
      label: row.label,
      amount: value(`${def.key}.${row.row}`),
      effect: row.effect,
      kind: 'movement' as const,
    }))
    const end = roundOre(movements.reduce((sum, row) => sum + row.effect * row.amount, opening))
    closing[def.key] = end
    // Anskaffningsvärden always print; another block only when it holds a figure.
    if (def.key !== 'cost' && opening === 0 && end === 0 && movements.every((row) => row.amount === 0)) continue
    blocks.push({
      key: def.key,
      contra: def.contra,
      rows: [
        { key: `${def.key}.opening`, label: def.opening, amount: opening, effect: 1, kind: 'opening' },
        ...movements.filter((row) => row.amount !== 0),
        { key: `${def.key}.closing`, label: def.closing, amount: end, effect: 1, kind: 'closing' },
      ],
    })
  }

  return {
    post,
    label,
    blocks,
    carrying: roundOre(closing.cost - closing.depreciation - closing.impairment),
  }
}

/**
 * The note's tables for the year: the register's assets grouped per balance
 * sheet post, with the stated rows. An asset whose account is in no post
 * keeps its register category as an untagged table of its own. A post with
 * stated rows, or with an amount carried from earlier years, gets its table
 * even without a register asset.
 */
export function buildK2FixedAssetTables(params: {
  assets: AnlaggningAsset[]
  periodStart: string
  periodEnd: string
  stated: FixedAssetNoteRows
  /** The balance sheet post of a BAS asset account, null when none covers it. */
  postOfAccount: (account: string) => string | null
  /** The label the balance sheet prints the post with. */
  labelOfPost: (post: string) => string
  /** Balance sheet order of the posts (K2_BR_MAPPINGS). */
  postOrder: readonly string[]
  /**
   * What each post's write-down accounts hold beyond the register
   * (writeDownsOutsideRegisterByPost). A post with a table shows them in it;
   * the ledger note keeps the posts without one.
   */
  outsideWriteDowns?: ReadonlyMap<string, WriteDownsOutsideRegister>
  /** What the earlier years' stated rows left in the opening balances (carriedFromEarlierYears). */
  carried?: ReadonlyMap<string, CarriedOpening>
}): FixedAssetNoteTable[] {
  const { assets, periodStart, periodEnd, stated, postOfAccount, labelOfPost, postOrder, outsideWriteDowns, carried } = params
  const UNMAPPED = 'category:'
  const groupOf = (asset: AnlaggningAsset): string => {
    const post = asset.bas_asset_account ? postOfAccount(asset.bas_asset_account) : null
    return post ?? `${UNMAPPED}${asset.category}`
  }
  const byGroup = new Map(buildRollforward(assets, periodStart, periodEnd, groupOf).map((row) => [row.category, row]))

  const groups = new Set<string>([
    ...byGroup.keys(),
    ...Object.keys(stated).filter(isNotePost),
    ...[...(carried?.keys() ?? [])].filter(isNotePost),
  ])
  const rank = (group: string): number => {
    if (group.startsWith(UNMAPPED)) return postOrder.length + 1 + Object.keys(CATEGORY_LABELS).indexOf(group.slice(UNMAPPED.length))
    const index = postOrder.indexOf(group)
    return index === -1 ? postOrder.length : index
  }

  return [...groups]
    .sort((a, b) => rank(a) - rank(b))
    .map((group) => {
      const unmapped = group.startsWith(UNMAPPED)
      const category = group.slice(UNMAPPED.length)
      const label = unmapped ? (CATEGORY_LABELS[category] ?? category) : labelOfPost(group)
      // Only a post whose note has these rows is tagged, tied and takes
      // stated rows: an asset booked on pågående nyanläggningar keeps its
      // table, under that post's name, as plain figures.
      const post = !unmapped && isNotePost(group) ? group : null
      return buildTable(
        post,
        label,
        byGroup.get(group) ?? emptyRollforward(group),
        post ? (stated[post] ?? {}) : {},
        (post && outsideWriteDowns?.get(post)) || NOTHING_OUTSIDE,
        (post && carried?.get(post)) || NOTHING_CARRIED,
      )
    })
}

/** How a row's figure prints: a reduction of the redovisat värde with a minus. */
export function fixedAssetRowDisplay(block: FixedAssetNoteBlock, row: FixedAssetNoteRow): number {
  return (block.contra ? -1 : 1) * row.effect * row.amount
}

// The note's minus sign, as in every note body. A zero never carries a sign.
function signedKronor(amount: number): string {
  return formatNoteKronor(roundWhole(amount))
}

/** The note body the PDF prints: the same rows as the tagged tables, as text. */
export function fixedAssetNoteBody(tables: readonly FixedAssetNoteTable[]): string {
  const lines: string[] = []
  for (const table of tables) {
    lines.push(table.label)
    for (const block of table.blocks) {
      for (const row of block.rows) {
        lines.push(`  ${row.label}: ${signedKronor(fixedAssetRowDisplay(block, row))} kr`)
      }
    }
    lines.push(`  ${FIXED_ASSET_CARRYING_LABEL}: ${signedKronor(table.carrying)} kr`)
    lines.push('')
  }
  return lines.join('\n').trimEnd()
}

/** Ingående redovisat värde of a table: what its blocks open the year with. */
export function fixedAssetOpeningCarrying(table: FixedAssetNoteTable): number {
  return roundOre(
    table.blocks.reduce((sum, block) => {
      const opening = block.rows.find((row) => row.kind === 'opening')?.amount ?? 0
      return sum + (block.contra ? -opening : opening)
    }, 0),
  )
}

/**
 * Why a post can close as the books do and open differently: each is
 * something the register holds that puts an amount in the opening balances
 * instead of on a row of the year, or the other way round.
 */
const OPENING_CAUSES =
  'Vanliga orsaker: en tillgång som kommit in under året (köp, rörelseförvärv, fusion eller omklassificering) har ett tidigare anskaffningsdatum än dagen den kom in; redan avskrivet belopp är angivet per ett datum inne i året och postens avskrivningar kan inte stämmas av mot bokföringen, så att beloppet helt eller delvis räknas som ingående avskrivningar; en tillgång har flyttats till ett konto i en annan post; eller en avyttring är bokförd ett annat år än den är registrerad.'

/** What the tie of each post to its books found (fixedAssetPostTieOut). */
export interface FixedAssetPostTieOut {
  /** Blocking: a post whose figures a user stated does not tie. */
  errors: string[]
  /** A post the register alone fills that closes wrong: replaced by the note-level message when the whole note is off. */
  closingWarnings: string[]
  /** A post the register alone fills that closes right and opens wrong: a finding of its own. */
  openingWarnings: string[]
  /** True when a stated post closes wrong: the same cause as a note-level mismatch, which is then not reported on top. */
  closingBlocked: boolean
  /** The posts named above: whatever else is checked on a post presumes it ties. */
  untiedPosts: Set<string>
}

/**
 * Each post's table against the books of its own balance sheet post, at the
 * end of the year and at its start. A row stated on the wrong post leaves the
 * note's total right and both posts wrong, and the iXBRL document tags the
 * figures per post, so a post in `statedPosts` (rows stated for the year, or
 * an amount carried from earlier years) that is more than 1 kr from `booked`
 * blocks the document. A post the register alone fills only warns, as the
 * note's total does (a register approximated before onboarding can differ
 * by design).
 *
 * The opening balance is compared when the closing ties: a table that closes
 * right and opens wrong shows the year's movements wrong by the difference.
 * OPENING_CAUSES names what the register can hold that does it.
 */
export function fixedAssetPostTieOut(
  tables: readonly FixedAssetNoteTable[],
  statedPosts: ReadonlySet<string>,
  /** The post's booked value at the start and at the end of the year, less what the ledger note discloses. */
  booked: { opening: (post: string) => number; closing: (post: string) => number },
): FixedAssetPostTieOut {
  const result: FixedAssetPostTieOut = {
    errors: [],
    closingWarnings: [],
    openingWarnings: [],
    closingBlocked: false,
    untiedPosts: new Set(),
  }
  for (const table of tables) {
    if (table.post === null) continue
    const stated = statedPosts.has(table.post)
    const closingOnBooks = booked.closing(table.post)
    if (Math.abs(table.carrying - closingOnBooks) > 1) {
      result.untiedPosts.add(table.post)
      const message = `Anläggningsnoten för ${table.label}: redovisat värde (${formatPdfKronor(table.carrying)} kr) stämmer inte med balansräkningens bokförda värde för posten (${formatPdfKronor(closingOnBooks)} kr).`
      if (stated) {
        result.closingBlocked = true
        result.errors.push(
          `${message} Noten har rader som angetts för året eller tidigare år (omräkningsdifferenser eller nedskrivningar som kommit genom fusion, försäljning, omklassificering eller omräkning): den måste stämma mot balansräkningen innan årsredovisningen kan låsas. Kontrollera att raderna motsvarar det som är bokfört på postens konton.`,
        )
      } else {
        result.closingWarnings.push(
          `${message} Kontrollera att tillgångarna i anläggningsregistret ligger på postens konton och att årets avskrivningar är bokförda.`,
        )
      }
      continue
    }
    const opening = fixedAssetOpeningCarrying(table)
    const openingOnBooks = booked.opening(table.post)
    if (Math.abs(opening - openingOnBooks) <= 1) continue
    result.untiedPosts.add(table.post)
    const message = `Anläggningsnoten för ${table.label}: ingående redovisat värde (${formatPdfKronor(opening)} kr) stämmer inte med postens bokförda värde vid årets ingång (${formatPdfKronor(openingOnBooks)} kr).`
    if (stated) {
      result.errors.push(
        `${message} Noten har rader som angetts för året eller tidigare år: de ingående balanserna måste stämma mot bokföringen innan årsredovisningen kan låsas. Kontrollera de angivna raderna och anläggningsregistret. ${OPENING_CAUSES}`,
      )
    } else {
      result.openingWarnings.push(`${message} Årets rader i noten blir då fel med samma belopp. ${OPENING_CAUSES}`)
    }
  }
  return result
}

/**
 * The redovisat värde is the balance sheet post: a table that ties to the
 * post's booked value (the krona fixedAssetPostTieOut allows, on the same
 * unrounded figures) prints the balance sheet's own figure for the post, in
 * whole kronor as the balance sheet rounds it, so the note, the balance
 * sheet and both documents show one number. A table that does not tie keeps
 * its own figure, which the tie-out reports; so does a post with write-downs
 * the ledger note discloses, whose table is not the whole post.
 */
export function alignCarryingWithBalanceSheet(
  tables: readonly FixedAssetNoteTable[],
  /** What the post's accounts hold at the end of the year, unrounded; undefined when the post is not on the books. */
  bookedOnPost: (post: string) => number | undefined,
  /** The post as the balance sheet prints it. */
  balanceSheetPost: (post: string) => number | undefined,
): FixedAssetNoteTable[] {
  return tables.map((table) => {
    if (table.post === null) return table
    const booked = bookedOnPost(table.post)
    const onBalanceSheet = balanceSheetPost(table.post)
    return booked !== undefined && onBalanceSheet !== undefined && Math.abs(table.carrying - booked) <= 1
      ? { ...table, carrying: onBalanceSheet }
      : table
  })
}

/** The note's closing redovisat värde over every table, for the tie to the balance sheet. */
export function fixedAssetNoteCarryingTotal(tables: readonly FixedAssetNoteTable[]): number {
  return roundOre(tables.reduce((sum, table) => sum + table.carrying, 0))
}
