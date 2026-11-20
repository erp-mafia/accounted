import styles from './skills.module.css'

/**
 * The picture of a flow: three raised steps joined by a path, the last one
 * ticked. At rest it stands still, tilted like the folder; when its card (or
 * stage, or banner) is hovered it straightens, a light travels the path
 * behind the steps and each step lifts in turn. Plain CSS, in the flow's
 * colour; reduced motion keeps it still.
 */
export function FlowSymbol({ hue, size = 64, live = false }: { hue: number; size?: number; live?: boolean }) {
  return (
    <span className={styles.flowSym} data-live={live ? '' : undefined} style={{ width: size, height: size, ['--fh' as string]: hue }} aria-hidden>
      <span className={styles.flowBox} style={{ transform: `scale(${size / 64})` }}>
        <span className={styles.flowTilt}>
          <svg className={styles.flowPath} width="64" height="64" viewBox="0 0 64 64" fill="none">
            <path d="M18 14 C 46 14, 46 14, 46 32 C 46 50, 46 50, 18 50" strokeWidth="3" strokeLinecap="round" strokeDasharray="1 5.5" />
          </svg>
          <span className={styles.flowDot} />
          <span className={`${styles.flowStep} ${styles.fs1}`} />
          <span className={`${styles.flowStep} ${styles.fs2}`} />
          <span className={`${styles.flowStep} ${styles.fs3}`}>
            <svg width="12" height="12" viewBox="0 0 12 12" fill="none"><path d="M2.5 6.2 l2.3 2.3 l4.7 -4.9" stroke="#fff" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>
          </span>
        </span>
      </span>
    </span>
  )
}
