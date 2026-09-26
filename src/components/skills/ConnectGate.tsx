'use client'

import { useTranslations } from 'next-intl'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { Button } from '@/components/ui/button'
import { AI_CLIENTS, type AiClient } from '@/lib/onboarding/ai-clients'
import styles from './skills.module.css'

/**
 * "Koppla din AI först": what "Skapa med din AI" opens while no AI is
 * connected. Creating happens in the company's own AI (create_prompt_*), so
 * the page has nothing to create with until one is connected.
 */
export function ConnectGate({ open, onClose, onConnect }: {
  open: boolean
  onClose: () => void
  onConnect: (client: AiClient) => void
}) {
  const t = useTranslations('skills_registry')
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(next) => { if (!next) onClose() }}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Content className={styles.full} aria-describedby={undefined}>
          <div className={styles.cstep}>
            <span className={styles.kick}>{t('creator.gate_kick')}</span>
            <DialogPrimitive.Title asChild><h2 className={styles.cq}>{t('creator.gate_title')}</h2></DialogPrimitive.Title>
            <p className={styles.cbody}>{t('creator.gate_body')}</p>
            <div className={styles.kgrid} style={{ maxWidth: 640 }}>
              {AI_CLIENTS.map((c) => (
                <Button key={c.id} variant="outline" size="lg" onClick={() => onConnect(c.id)}>{t('connect_client', { client: c.name })}</Button>
              ))}
            </div>
            <div className={styles.cfoot}><Button variant="outline" onClick={onClose}>{t('cancel')}</Button></div>
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  )
}
