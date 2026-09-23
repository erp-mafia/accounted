/**
 * Inline-XBRL fact emission primitives.
 *
 * A FactWriter instance is scoped to one document. It
 *   - validates every emitted fact against the generated taxonomy registry
 *     (unknown concept / wrong periodType / wrong datatype throws at
 *     generation time instead of earning a 4001/4008 from Bolagsverket),
 *   - tracks which contexts and units were actually referenced so the
 *     ix:header only declares what the document uses (TA §2.17),
 *   - collects ix:hidden facts (vallistor per TA §2.15/§3.9.3).
 *
 * Naming follows TA §2.16: contexts period0/period1/…, balans0/balans1/…,
 * units SEK / procent / antal-anstallda.
 */

import type { TaxonomyEntryPoint } from '../taxonomy/entry-points'
import {
  mustGetConcept,
  type TaxonomyRegistry,
  type TaxonomyConcept,
} from '../taxonomy/registry'
import { el, escapeText, formatPercentAbs, formatSekAbs, selfClosing, type Attrs } from './xml'

interface ContextDef {
  id: string
  kind: 'duration' | 'instant'
  startDate?: string
  endDate?: string
  instant?: string
}

const UNIT_MEASURES: Record<string, string> = {
  SEK: 'iso4217:SEK',
  procent: 'xbrli:pure',
  'antal-anstallda': 'se-k2-type:AntalAnstallda',
}

export interface MoneyOptions {
  /** Render a presentational minus before the element (costs in RR). The
   *  fact value itself stays oriented to the concept's natural balance. */
  displayMinus?: boolean
  /** Show the amount wrapped in a span with this class (sum/total styling). */
  spanClass?: string
  id?: string
  tupleRef?: string
  order?: string
}

export class FactWriter {
  private readonly contexts = new Map<string, ContextDef>()
  private readonly usedContexts = new Set<string>()
  private readonly usedUnits = new Set<string>()
  private readonly hiddenFacts: string[] = []
  private tupleCounter = 0

  constructor(
    private readonly entryPoint: TaxonomyEntryPoint,
    private readonly registry: TaxonomyRegistry,
    private readonly entityOrgNumber: string,
  ) {}

  // ---- contexts -----------------------------------------------------------

  addDurationContext(id: string, startDate: string, endDate: string): void {
    this.contexts.set(id, { id, kind: 'duration', startDate, endDate })
  }

  addInstantContext(id: string, instant: string): void {
    this.contexts.set(id, { id, kind: 'instant', instant })
  }

  hasContext(id: string): boolean {
    return this.contexts.has(id)
  }

  private resolveContext(id: string, concept: TaxonomyConcept, name: string): void {
    const ctx = this.contexts.get(id)
    if (!ctx) throw new Error(`Fact ${name}: context "${id}" is not declared`)
    if (concept.periodType === 'duration' && ctx.kind !== 'duration') {
      throw new Error(`Fact ${name}: duration concept tagged with instant context "${id}"`)
    }
    if (concept.periodType === 'instant' && ctx.kind !== 'instant') {
      throw new Error(`Fact ${name}: instant concept tagged with duration context "${id}"`)
    }
    this.usedContexts.add(id)
  }

  private qname(concept: TaxonomyConcept, name: string): string {
    if (!this.entryPoint.namespaces[concept.ns]) {
      throw new Error(`Fact ${name}: namespace prefix "${concept.ns}" missing from entry point`)
    }
    return `${concept.ns}:${name}`
  }

  // ---- numeric facts ------------------------------------------------------

  /**
   * Whole-SEK monetary fact. `value` is oriented to the concept's natural
   * balance (credit-positive for credit concepts, debit-positive for debit
   * concepts); negative values get the `sign="-"` attribute per TA §2.10.6.
   */
  money(name: string, contextRef: string, value: number, opts: MoneyOptions = {}): string {
    const concept = mustGetConcept(this.registry, name)
    if (concept.dataType !== 'xbrli:monetaryItemType') {
      throw new Error(`Fact ${name}: money() used on ${concept.dataType}`)
    }
    this.resolveContext(contextRef, concept, name)
    this.usedUnits.add('SEK')
    const rounded = Math.round(value)
    const attrs: Attrs = {
      contextRef,
      name: this.qname(concept, name),
      unitRef: 'SEK',
      decimals: '0',
      scale: '0',
      format: 'ixt:numspacecomma',
      sign: rounded < 0 ? '-' : null,
      id: opts.id ?? null,
      tupleRef: opts.tupleRef ?? null,
      order: opts.order ?? null,
    }
    let markup = el('ix:nonFraction', attrs, formatSekAbs(rounded))
    if (opts.spanClass) markup = el('span', { class: opts.spanClass }, markup)
    // Presentational minus is an XOR: a cost row (displayMinus) with its
    // natural sign shows "−X", but a DEVIATING cost (negative fact value,
    // sign="-", i.e. net income on a cost line) displays positive per the
    // RR convention; conversely a deviating income row displays "−X".
    if ((opts.displayMinus ?? false) !== rounded < 0) markup = `−${markup}`
    return markup
  }

  /** Percent fact (xbrli:pure) per TA §2.12: text "35,5", scale −2. */
  percent(name: string, contextRef: string, valuePct: number): string {
    const concept = mustGetConcept(this.registry, name)
    if (concept.dataType !== 'xbrli:pureItemType') {
      throw new Error(`Fact ${name}: percent() used on ${concept.dataType}`)
    }
    this.resolveContext(contextRef, concept, name)
    this.usedUnits.add('procent')
    const attrs: Attrs = {
      contextRef,
      name: this.qname(concept, name),
      unitRef: 'procent',
      decimals: '3',
      scale: '-2',
      format: 'ixt:numspacecomma',
      sign: valuePct < 0 ? '-' : null,
    }
    const markup = el('ix:nonFraction', attrs, formatPercentAbs(valuePct))
    return valuePct < 0 ? `−${markup}` : markup
  }

  /** Antal-fact (medelantal anställda) per TA §2.14, one decimal. */
  antalAnstallda(name: string, contextRef: string, value: number): string {
    const concept = mustGetConcept(this.registry, name)
    this.resolveContext(contextRef, concept, name)
    this.usedUnits.add('antal-anstallda')
    const isWhole = Number.isInteger(value)
    return el(
      'ix:nonFraction',
      {
        contextRef,
        name: this.qname(concept, name),
        unitRef: 'antal-anstallda',
        decimals: isWhole ? '0' : '1',
        scale: '0',
        format: 'ixt:numspacecomma',
      },
      isWhole ? String(value) : value.toFixed(1).replace('.', ','),
    )
  }

  // ---- non-numeric facts --------------------------------------------------

  /** Plain-text fact; content is escaped. */
  textPlain(
    name: string,
    contextRef: string,
    content: string,
    opts: { id?: string; tupleRef?: string; order?: string; continuedAt?: string } = {},
  ): string {
    return this.nonNumeric(name, contextRef, escapeText(content), opts)
  }

  /** Fact wrapping pre-built XHTML (e.g. <p>…</p> paragraphs). */
  textHtml(
    name: string,
    contextRef: string,
    innerXhtml: string,
    opts: { id?: string; continuedAt?: string } = {},
  ): string {
    return this.nonNumeric(name, contextRef, innerXhtml, opts)
  }

  /** ISO date fact (TA §2.11 format YYYY-MM-DD, no format attribute). */
  date(
    name: string,
    contextRef: string,
    isoDate: string,
    opts: { id?: string; tupleRef?: string; order?: string } = {},
  ): string {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(isoDate)) {
      throw new Error(`Fact ${name}: "${isoDate}" is not an ISO date`)
    }
    return this.nonNumeric(name, contextRef, isoDate, opts)
  }

  private nonNumeric(
    name: string,
    contextRef: string,
    inner: string,
    opts: { id?: string; tupleRef?: string; order?: string; continuedAt?: string },
  ): string {
    const concept = mustGetConcept(this.registry, name)
    if (concept.kind !== 'item') throw new Error(`Fact ${name}: is a tuple, not an item`)
    this.resolveContext(contextRef, concept, name)
    return el(
      'ix:nonNumeric',
      {
        contextRef,
        name: this.qname(concept, name),
        id: opts.id ?? null,
        tupleRef: opts.tupleRef ?? null,
        order: opts.order ?? null,
        continuedAt: opts.continuedAt ?? null,
      },
      inner,
    )
  }

  // ---- vallistor (hidden enumeration facts, TA §2.15 / §3.9.3) ------------

  hiddenEnum(name: string, contextRef: string, memberQName: string): void {
    const concept = mustGetConcept(this.registry, name)
    this.resolveContext(contextRef, concept, name)
    const memberLocal = memberQName.split(':')[1]
    if (memberLocal) {
      // Members live in the registry too (se-mem-base): validate when known.
      const member = this.registry.concepts[memberLocal]
      if (!member) throw new Error(`Vallista ${name}: unknown member ${memberQName}`)
    }
    this.hiddenFacts.push(
      el('ix:nonNumeric', { name: this.qname(concept, name), contextRef }, escapeText(memberQName)),
    )
  }

  /** Hidden plain fact (räkenskapsårets första/sista dag in allmän info). */
  hiddenDate(name: string, contextRef: string, isoDate: string): void {
    this.hiddenFacts.push(this.date(name, contextRef, isoDate))
  }

  /** Hidden boolean fact (e.g. ArsredovisningEjTaggadInformation, TA §2.22). */
  hiddenBoolean(name: string, contextRef: string, value: boolean): void {
    this.hiddenFacts.push(this.nonNumeric(name, contextRef, value ? 'true' : 'false', {}))
  }

  /** Hidden tuple + members (avskrivningsprincip notes etc.). */
  hiddenTuple(tupleName: string, members: Array<{ name: string; context: string; value: string }>): void {
    const tupleId = this.declareTupleId(tupleName)
    const parts: string[] = [this.tupleDeclaration(tupleName, tupleId)]
    members.forEach((member, index) => {
      parts.push(
        this.textPlain(member.name, member.context, member.value, {
          tupleRef: tupleId,
          order: `${index + 1}.0`,
        }),
      )
    })
    this.hiddenFacts.push(parts.join('\n'))
  }

  // ---- tuples --------------------------------------------------------------

  declareTupleId(tupleName: string): string {
    const tuple = this.registry.tuples[tupleName]
    if (!tuple) throw new Error(`Tuple ${tupleName} not in taxonomy registry`)
    this.tupleCounter += 1
    return `${tupleName}${this.tupleCounter}`
  }

  tupleDeclaration(tupleName: string, tupleId: string): string {
    const tuple = this.registry.tuples[tupleName]
    if (!tuple) throw new Error(`Tuple ${tupleName} not in taxonomy registry`)
    return selfClosing('ix:tuple', { name: `${tuple.ns}:${tupleName}`, tupleID: tupleId })
  }

  // ---- header assembly -----------------------------------------------------

  /**
   * Render the full ix:header (hidden + references + resources). Call after
   * the body has been generated so only referenced contexts/units exist.
   */
  renderHeader(): string {
    const hidden =
      this.hiddenFacts.length > 0 ? el('ix:hidden', {}, this.hiddenFacts.join('\n')) : ''

    const references = el(
      'ix:references',
      {},
      this.entryPoint.schemaRefs
        .map((href) => selfClosing('link:schemaRef', { 'xlink:type': 'simple', 'xlink:href': href }))
        .join('\n'),
    )

    const contextXml: string[] = []
    for (const id of [...this.usedContexts].sort()) {
      const ctx = this.contexts.get(id)
      if (!ctx) continue
      const period =
        ctx.kind === 'duration'
          ? el(
              'xbrli:period',
              {},
              el('xbrli:startDate', {}, ctx.startDate ?? '') +
                el('xbrli:endDate', {}, ctx.endDate ?? ''),
            )
          : el('xbrli:period', {}, el('xbrli:instant', {}, ctx.instant ?? ''))
      contextXml.push(
        el(
          'xbrli:context',
          { id },
          el(
            'xbrli:entity',
            {},
            el(
              'xbrli:identifier',
              { scheme: 'http://www.bolagsverket.se' },
              escapeText(this.entityOrgNumber),
            ),
          ) + period,
        ),
      )
    }

    const unitXml: string[] = []
    for (const unitId of [...this.usedUnits].sort()) {
      unitXml.push(
        el('xbrli:unit', { id: unitId }, el('xbrli:measure', {}, UNIT_MEASURES[unitId])),
      )
    }

    const resources = el('ix:resources', {}, contextXml.join('\n') + '\n' + unitXml.join('\n'))
    return el(
      'div',
      { style: 'display:none' },
      el('ix:header', {}, [hidden, references, resources].filter(Boolean).join('\n')),
    )
  }
}
