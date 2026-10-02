import styles from './skills.module.css'

/**
 * The picture of an agent instruction: a folder in the item's colour with
 * three papers inside. Closed it rests with the papers tucked in; hovering
 * its card (or `open`) lifts the front flap and fans the papers out. On the
 * item's page it stands open and the papers drift a little. Plain CSS, drawn
 * for Accounted (the look follows the founder's folder reference; no code is
 * taken from it).
 */
export function Folder({ hue, size = 64, open = false, drift = false }: { hue: number; size?: number; open?: boolean; drift?: boolean }) {
  return (
    <span
      className={styles.folder}
      data-open={open ? '' : undefined}
      data-drift={drift ? '' : undefined}
      style={{ ['--fh' as string]: hue, width: size, height: Math.round(size * 0.8) }}
      aria-hidden
    >
      <span className={styles.folderBack} />
      <span className={`${styles.folderPaper} ${styles.fp1}`} />
      <span className={`${styles.folderPaper} ${styles.fp2}`} />
      <span className={`${styles.folderPaper} ${styles.fp3}`} />
      <span className={styles.folderFront} />
    </span>
  )
}
