/**
 * The context graph: what an agent receives about the company, as a web of
 * linked things (the picture at the top of the wiki's context view).
 *
 * Pure types. The builder (build.ts) reads them off the briefing; the layout
 * (layout.ts) places them; the component draws them.
 */

/**
 * Who stands behind a dot. The four chip families are taught (what people
 * and agents saved), read (what Accounted reads from the books), wait (what
 * is waiting on someone) and instructions; agent is the dot in the middle and
 * ref a neutral thing others point at (an account, the group). The legend
 * names taught and instructions with the words of the agent picture's card,
 * Minne and Kunskap (familyLabel in components/context-graph/node-text.ts).
 */
export type GraphFamily = 'agent' | 'taught' | 'read' | 'wait' | 'instructions' | 'ref'

/** The families a chip filters by, in the order the chips are drawn. */
export const CHIP_FAMILIES = ['taught', 'read', 'wait', 'instructions'] as const
export type ChipFamily = (typeof CHIP_FAMILIES)[number]

export type GraphNodeKind =
  | 'agent'
  | 'fact'
  | 'group_fact'
  | 'group'
  | 'counterparty'
  | 'account'
  | 'bank'
  | 'skatteverket'
  | 'inbox'
  | 'owners'
  | 'archive'
  | 'check'
  | 'suggestion'
  | 'deadline'
  | 'question'
  | 'skill'
  | 'workflows'
  | 'permissions'
  | 'more'

export interface GraphNode {
  id: string
  family: GraphFamily
  kind: GraphNodeKind
  /**
   * The short name under the dot when it comes from the data itself (a
   * counterparty, an account number, the start of a fact). null when the kind
   * names it (the bank, the agent): the component then uses its own label.
   */
  label: string | null
  /** What the thing says, in the briefing's own words; null when the kind and the fields below say it all. */
  text: string | null
  /** A second line from the briefing (a skill's description, what a question is about, a deadline's state). */
  detail?: string | null
  /** A knowledge area's id as the briefing sends it (atom_id): the name people read is looked up by it. */
  atomId?: string | null
  /** A date the briefing gives for it (saved, last booked, last synced, due, asked), as sent. */
  date?: string | null
  /** A counterparty's account, or an account's own number. */
  account?: string | null
  /** A counterparty pattern's evidence: booked this way `agree` times of `seen` in twelve months. */
  evidence?: { agree: number; seen: number } | null
  /** A supplier pattern's VAT treatment code. */
  vatTreatment?: string | null
  /** A fact's kind (fact, preference, pattern, correction). */
  factKind?: string | null
  /** Who saved a fact and through which client, when the briefing says. */
  savedBy?: string | null
  client?: string | null
  /** A check's result: the difference in kr or a count; null when the check gave none. */
  result?: { difference: number | null; unit: string } | null
  /** A status code the briefing sends (the Skatteverket connection). */
  status?: string | null
  /** A count the node stands for (documents, workflows, permission areas, the things a "+N" dot holds). */
  count?: number | null
  /** A second count beside it (agreements in the archive). */
  count2?: number | null
  /** A money amount in SEK (a deadline's). */
  amount?: number | null
  /** For a "+N" dot: the kind of thing it holds more of. */
  moreOf?: GraphNodeKind
}

/** An undirected link, stored once. */
export type GraphEdge = readonly [string, string]

export interface ContextGraphModel {
  nodes: GraphNode[]
  edges: GraphEdge[]
  /**
   * How many things each chip family holds in the briefing, the ones behind a
   * "+N" dot included. taught: the company's remembered facts and its
   * group's. read: the connections, the owners, the archive and the
   * counterparties. wait: the checks that differ, the suggestions, the
   * deadlines and the questions. instructions: the knowledge areas the
   * briefing lists (`atoms`), plus one for the workflows and one for the
   * permissions when it carries them. The legend draws a chip for a family
   * whose count is above zero and shows no number.
   */
  counts: Record<ChipFamily, number>
  /** How many things the caps left out of the picture (they stay in the lists below it). */
  hidden: number
  /** True when the briefing holds nothing to draw beside the agent itself. */
  empty: boolean
}
