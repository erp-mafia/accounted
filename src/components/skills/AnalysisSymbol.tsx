import styles from './skills.module.css'

/**
 * The picture of an analysis: three raised bars on a tilted sheet, like the
 * folder and the flow's steps. At rest it stands still; when its card (or
 * stage, or banner) is hovered it straightens, the bars rise one after the
 * other and a trend line draws across their tops. Plain CSS, in the item's
 * colour; reduced motion keeps it still.
 */
export function AnalysisSymbol({ hue, size = 64 }: { hue: number; size?: number }) {
  return (
    <span className={styles.anaSym} style={{ width: size, height: size, ['--fh' as string]: hue }} aria-hidden>
      <span className={styles.anaBox} style={{ transform: `scale(${size / 64})` }}>
        <span className={styles.anaTilt}>
          <span className={styles.anaSheet} />
          <span className={`${styles.anaBar} ${styles.ab1}`} />
          <span className={`${styles.anaBar} ${styles.ab2}`} />
          <span className={`${styles.anaBar} ${styles.ab3}`} />
          <svg className={styles.anaLine} width="64" height="64" viewBox="0 0 64 64" fill="none">
            <path d="M17 36 L32 26 L47 13" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            <circle cx="47" cy="13" r="2.6" />
          </svg>
        </span>
      </span>
    </span>
  )
}
