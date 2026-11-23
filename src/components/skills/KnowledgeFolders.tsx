'use client'

import { useState } from 'react'
import Link from 'next/link'
import useSWR from 'swr'
import { useTranslations } from 'next-intl'
import { ArrowLeftIcon } from '@/components/icons'
import { useCompany } from '@/contexts/CompanyContext'
import { Button } from '@/components/ui/button'
import { LoadError } from '@/components/ui/empty-state'
import { Skeleton } from '@/components/ui/skeleton'
import { ToolbarSearch } from '@/components/ui/toolbar-search'
import type { KnowledgeOption } from '@/lib/agent-skills/knowledge-choices'
import { groupKnowledge, SEARCH_FROM_TILES, type KnowledgeGroupId } from '@/lib/agent-skills/knowledge-list'
import { knowledgeItemId } from '@/lib/agent-context/wiki-views'
import { useCanWrite } from '@/lib/hooks/use-can-write'
import { cn } from '@/lib/utils'
import { createItemHref, readCatalog, readOptions } from './data'
import { Folder } from './Folder'
import { itemHue } from './hues'
import { ItemSymbol } from './ItemSymbol'
import { KnowledgeItemView } from './KnowledgeItemView'
import { useKnowledgeDesc, useKnowledgeName } from './knowledge-labels'
import { ownItemRows, type OwnItemRow } from './own-item-rows'
import styles from './skills.module.css'

/** Where the company's own items and the page that adds one answer: the catalogue's own addresses. */
const OWN_ITEMS_BASE = '/skills'

/** The quiet text link of the panel. */
const QUIET_LINK = 'text-foreground underline decoration-foreground/25 underline-offset-[3px] hover:decoration-foreground/60'

/** The label of each group, in skills_registry; the one group of an unknown state has none. */
const GROUP_LABEL: Record<Exclude<KnowledgeGroupId, 'all'>, string> = {
  industry: 'featured_industry',
  general: 'folders_general',
  form: 'folders_form',
  also: 'folders_also',
}

/**
 * The catalogue's knowledge list as folders, for the agent picture's Kunskap
 * panel: a grid of folder tiles under small labels (groupKnowledge says
 * which group an item is in, from its tier and from `active`, the ids the
 * agent gets today). What exists but is not active for the company is drawn
 * faded under its own label. With `active` unknown the tiles are one grid
 * with no labels, and the first line says so.
 *
 * A tile is a button: it opens the item in place (KnowledgeItemView), with a
 * way back to the folders. The items are read by the catalogue page's own
 * loader, under its own key, so the two share one read.
 *
 * Under the groups, the company's own items of every kind (ownItemRows: its
 * flows, knowledge and analyses and its firm's, as the catalogue page lists
 * them under Egna), each a link to its own page, and one link to the page
 * that adds one. The own items are read by the catalogue page's loader too
 * (GET /api/skills, the same key). A person who cannot write is shown the
 * items and no link to add one.
 *
 * `item` is the item the address names (as knowledgeItemParam spells it):
 * the list opens on that item's folder, and opens it when the address comes
 * to name it. An item that is not in the list opens nothing. `onItemClose`
 * is called when an opened folder is left for the folders.
 */
export function KnowledgeFolders({ active, item = null, onItemClose }: { active: readonly string[] | null; item?: string | null; onItemClose?: () => void }) {
  const t = useTranslations('skills_registry')
  const tCommon = useTranslations('common')
  const { company } = useCompany()
  const { canWrite } = useCanWrite()
  const knowledgeName = useKnowledgeName()
  const knowledgeDesc = useKnowledgeDesc()
  const options = useSWR(company ? ['/api/agents/knowledge', company.id] : null, ([url]) => readOptions(url))
  const catalog = useSWR(company ? ['/api/skills', company.id] : null, ([url]) => readCatalog(url))
  const [q, setQ] = useState('')
  const [openId, setOpenId] = useState<string | null>(item ? knowledgeItemId(item) : null)
  // The item the address named at the last render: a change to another item opens that one.
  const [namedItem, setNamedItem] = useState(item)
  if (item !== namedItem) {
    setNamedItem(item)
    if (item) setOpenId(knowledgeItemId(item))
  }

  if (options.error && !options.data) return <LoadError title={t('load_failed')} onRetry={() => void options.mutate()} />
  if (!options.data || !company) {
    return (
      <div aria-busy className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <Skeleton key={i} className="h-24 w-full rounded-lg" />
        ))}
      </div>
    )
  }

  const opened = openId ? options.data.find((option) => option.id === openId) : undefined
  if (opened) {
    return (
      <div className="space-y-4">
        <Button
          variant="ghost"
          className="-ml-2"
          onClick={() => {
            setOpenId(null)
            onItemClose?.()
          }}
        >
          <ArrowLeftIcon className="h-4 w-4" aria-hidden />
          {t('folders_back')}
        </Button>
        <KnowledgeItemView option={opened} companyId={company.id} />
      </div>
    )
  }

  const grouped = groupKnowledge(options.data, active ? new Set(active) : null)
  const tiles = grouped.groups.reduce((n, group) => n + group.items.length, 0)
  const query = q.trim().toLocaleLowerCase('sv')
  const matches = (option: KnowledgeOption) =>
    !query || `${knowledgeName(option.id, option.title)} ${knowledgeDesc(option.id, option.summary)}`.toLocaleLowerCase('sv').includes(query)
  const shown = grouped.groups.map((group) => ({ ...group, items: group.items.filter(matches) })).filter((group) => group.items.length > 0)
  // The company's own items: null until the catalogue has been read, so nothing is said about them before it is known.
  const own = catalog.data ? ownItemRows(catalog.data, OWN_ITEMS_BASE) : null
  const ownShown = (own ?? []).filter((row) => !query || `${row.title} ${row.desc}`.toLocaleLowerCase('sv').includes(query))
  const ownFailed = !!catalog.error && !catalog.data

  return (
    <div className="space-y-5">
      <div className="text-[13px] text-foreground/80">{grouped.active === null ? t('folders_unknown') : t('folders_count', { count: grouped.active })}</div>
      {tiles + (own?.length ?? 0) > SEARCH_FROM_TILES && (
        <ToolbarSearch aria-label={t('search_label')} placeholder={t('search_rules')} value={q} onChange={(e) => setQ(e.target.value)} />
      )}
      {shown.map((group) => (
        <section key={group.id} aria-label={group.id === 'all' ? t('kind_rules') : t(GROUP_LABEL[group.id])}>
          {group.id !== 'all' && <div className="pb-2 text-xs font-medium text-foreground/80">{t(GROUP_LABEL[group.id])}</div>}
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {group.items.map((option) => (
              <li key={option.id} className="min-w-0">
                <FolderTile
                  name={knowledgeName(option.id, option.title)}
                  desc={knowledgeDesc(option.id, option.summary)}
                  hue={itemHue('rules', option.id)}
                  faded={group.id === 'also'}
                  onOpen={() => setOpenId(option.id)}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
      {shown.length === 0 &&
        ownShown.length === 0 &&
        (query ? (
          <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
            {t('no_hits')}
            <button type="button" className={QUIET_LINK} onClick={() => setQ('')}>
              {tCommon('clear_search')}
            </button>
          </div>
        ) : (
          <div className="text-[13px] text-muted-foreground">{t('place_empty')}</div>
        ))}
      {(ownShown.length > 0 || ownFailed) && (
        <section aria-label={t('view_own')}>
          <div className="pb-2 text-xs font-medium text-foreground/80">{t('view_own')}</div>
          {ownFailed ? (
            // Own items that could not be read are not "none": the line says so, with a retry.
            <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
              {t('load_failed')}
              <button type="button" className={QUIET_LINK} onClick={() => void catalog.mutate()}>
                {t('retry')}
              </button>
            </div>
          ) : (
            <ul className="grid grid-cols-2 gap-2 sm:grid-cols-3">
              {ownShown.map((row) => (
                <li key={row.key} className="min-w-0">
                  <OwnItemTile row={row} note={row.draft ? t('draft_tag') : t(`kind_one_${row.kind}`)} />
                </li>
              ))}
            </ul>
          )}
        </section>
      )}
      {/* The way to add one: after the own items, or alone when the company has none. Not while a search narrows the list. */}
      {canWrite && !query && (own !== null || ownFailed) && (
        <div className="text-[13px]">
          <Link href={createItemHref(OWN_ITEMS_BASE, 'rules')} className={QUIET_LINK}>
            {t('own_add')}
          </Link>
        </div>
      )}
    </div>
  )
}

/**
 * One of the company's own items: the picture of its kind (a folder for
 * knowledge, steps for a flow, bars for an analysis) in the colour its own
 * page gives it, its name, and one quiet word under it: its kind, or that
 * it waits to be added. A link, not a button: it opens the item's own page.
 * The name is what a person typed, so it is masked in recordings and its one
 * line is left to the page.
 */
function OwnItemTile({ row, note }: { row: OwnItemRow; note: string }) {
  return (
    <Link
      href={row.href}
      className={cn(
        styles.folderTile,
        'flex h-full w-full flex-col items-center gap-2.5 rounded-lg px-2 pb-3 pt-4 text-center outline-none transition-colors duration-150 hover:bg-secondary/60 focus-visible:ring-2 focus-visible:ring-ring/70',
      )}
    >
      <ItemSymbol kind={row.kind} hue={itemHue(row.kind, row.title)} size={56} />
      <span className="flex min-w-0 max-w-full flex-col gap-0.5">
        <span className="break-words text-[13px] font-medium leading-4 text-strong" data-ph-mask="">
          {row.title}
        </span>
        <span className="text-xs text-muted-foreground">{note}</span>
      </span>
    </Link>
  )
}

/**
 * One folder: the app's folder mark with the item's name under it. Its one
 * line is the tile's title: shown on hover, and read as the button's
 * description when it has focus.
 * Hovering or focusing the tile opens the folder a little, as its card does
 * in the catalogue.
 */
function FolderTile({ name, desc, hue, faded, onOpen }: { name: string; desc: string; hue: number; faded: boolean; onOpen: () => void }) {
  return (
    <button
      type="button"
      title={desc}
      onClick={onOpen}
      className={cn(
        styles.folderTile,
        'flex h-full w-full flex-col items-center gap-2.5 rounded-lg px-2 pb-3 pt-4 text-center outline-none transition-colors duration-150 hover:bg-secondary/60 focus-visible:ring-2 focus-visible:ring-ring/70',
        faded && 'opacity-60',
      )}
    >
      <Folder hue={hue} size={56} />
      <span className="break-words text-[13px] font-medium leading-4 text-strong">{name}</span>
    </button>
  )
}
