'use client'

import { useState } from 'react'
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
import { cn } from '@/lib/utils'
import { readOptions } from './data'
import { Folder } from './Folder'
import { itemHue } from './hues'
import { KnowledgeItemView } from './KnowledgeItemView'
import { useKnowledgeDesc, useKnowledgeName } from './knowledge-labels'
import styles from './skills.module.css'

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
 * `item` is the item the address names (as knowledgeItemParam spells it):
 * the list opens on that item's folder, and opens it when the address comes
 * to name it. An item that is not in the list opens nothing. `onItemClose`
 * is called when an opened folder is left for the folders.
 */
export function KnowledgeFolders({ active, item = null, onItemClose }: { active: readonly string[] | null; item?: string | null; onItemClose?: () => void }) {
  const t = useTranslations('skills_registry')
  const tCommon = useTranslations('common')
  const { company } = useCompany()
  const knowledgeName = useKnowledgeName()
  const knowledgeDesc = useKnowledgeDesc()
  const options = useSWR(company ? ['/api/agents/knowledge', company.id] : null, ([url]) => readOptions(url))
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

  return (
    <div className="space-y-5">
      <div className="text-[13px] text-foreground/80">{grouped.active === null ? t('folders_unknown') : t('folders_count', { count: grouped.active })}</div>
      {tiles > SEARCH_FROM_TILES && (
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
        (query ? (
          <div className="flex items-center gap-2 text-[13px] text-muted-foreground">
            {t('no_hits')}
            <button
              type="button"
              className="text-foreground underline decoration-foreground/25 underline-offset-[3px] hover:decoration-foreground/60"
              onClick={() => setQ('')}
            >
              {tCommon('clear_search')}
            </button>
          </div>
        ) : (
          <div className="text-[13px] text-muted-foreground">{t('place_empty')}</div>
        ))}
    </div>
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
