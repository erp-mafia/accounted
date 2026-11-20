'use client'

import { useEffect, useState } from 'react'
import Link from 'next/link'
import { useTranslations } from 'next-intl'
import { QUIET_LINK_CLASS } from '@/components/ui/dry-table'
import type { Dossier } from '@/lib/parties/register'
import { formatCurrency } from '@/lib/utils'
import { fetchCounterpartyOpenItems, type CounterpartyOpenItems } from './counterparty-client'

/**
 * On a customer's or a supplier's page, one quiet line when the same legal
 * person is also the other role (crm#1367): "Även leverantör · Vi betalar
 * netto 3 116 kr · Visa motpart", linking to the party dossier where the open
 * items of both sides and Kvitta live.
 */
export function CounterpartyRoleLink({ partyId, dossier, role }: { partyId: string; dossier: Dossier; role: 'customer' | 'supplier' }) {
  const t = useTranslations('parties')
  const bothRoles = Boolean(dossier.party.roles.customerId && dossier.party.roles.supplierId)
  const [items, setItems] = useState<CounterpartyOpenItems | null>(null)

  useEffect(() => {
    if (!bothRoles) return
    let cancelled = false
    void fetchCounterpartyOpenItems(partyId).then((next) => {
      if (!cancelled) setItems(next)
    })
    return () => {
      cancelled = true
    }
  }, [bothRoles, partyId])

  if (!bothRoles) return null
  const total = items?.totals[0] ?? null
  const net = !total
    ? null
    : total.direction === 'we_pay'
      ? t('net_we_pay', { amount: formatCurrency(Math.abs(total.net), total.currency) })
      : total.direction === 'they_pay'
        ? t('net_they_pay', { name: items?.party.name ?? '', amount: formatCurrency(total.net, total.currency) })
        : null

  return (
    <p className="text-[13px] text-muted-foreground">
      {role === 'customer' ? t('role_link_also_supplier') : t('role_link_also_customer')}
      {net ? ` · ${net}` : ''}
      {' · '}
      <Link href={`/parties?party=${encodeURIComponent(partyId)}`} className={QUIET_LINK_CLASS}>
        {t('role_link_show')}
      </Link>
    </p>
  )
}
