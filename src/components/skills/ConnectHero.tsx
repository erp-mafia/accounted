'use client'

import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { AI_CLIENTS, type AiClient } from '@/lib/onboarding/ai-clients'
import type { RegistrySkillId } from '@/lib/agent-skills/registry'
import { FlowSymbol } from './FlowSymbol'
import { itemHue } from './hues'
import styles from './skills.module.css'

/** Three flows that show what a connected AI does, in the order people meet them. */
const EXAMPLES: RegistrySkillId[] = ['kvittojakten', 'bookkeep', 'month-end-close']

/**
 * The page's first job for everyone without an AI connected (most users):
 * say what their own AI does in Accounted, let them connect it in one click,
 * and show three real flows as the proof. The catalogue below stays
 * browsable, so the rest of the page is the fuller answer to "what for?".
 */
export function ConnectHero({ onConnect }: { onConnect: (client: AiClient) => void }) {
  const t = useTranslations('skills_registry')
  return (
    <section className={styles.connectHero} aria-labelledby="connect-hero-title">
      <div className={styles.connectHeroText}>
        <span className={styles.connectKicker}>{t('connect_kicker')}</span>
        <h2 id="connect-hero-title">{t('connect_title')}</h2>
        <p>{t('connect_body')}</p>
        <div className={`${styles.gateClients} ${styles.connectClients}`}>
          {AI_CLIENTS.map((c, i) => (
            <Button key={c.id} size="lg" variant={i === 0 ? 'default' : 'outline'} className="gap-2" onClick={() => onConnect(c.id)}>
              {/* The plain logo, as on every other Claude button: no white plate on the dark pill. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={c.logo} alt="" width={16} height={16} className={styles.btnLogo} />
              {i === 0 ? t('connect_client', { client: c.name }) : c.name}
            </Button>
          ))}
        </div>
        <small>{t('connect_note')}</small>
      </div>
      <div className={styles.connectExamples}>
        <span className={styles.connectKicker}>{t('connect_examples')}</span>
        <ul>
          {EXAMPLES.map((id) => (
            <li key={id}>
              <FlowSymbol hue={itemHue('workflow', id, id)} size={36} />
              <div><b>{t(`skills.${id}.name`)}</b><span>{t(`skills.${id}.short`)}</span></div>
            </li>
          ))}
        </ul>
      </div>
    </section>
  )
}
