// ArtifactPanel 的图片预览组件:缩略图 + 元信息,点击放大成 lightbox。
// 从 ArtifactPanel.tsx 抽出,自包含(只有本地 expanded 状态)。
import { useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import styles from './ArtifactPanel.module.css'
import { formatSize } from './artifactFileUtils'

/** 图片预览 + 点击放大 lightbox。lightbox 行为对齐 MarkdownContent 里的
 *  ImgRenderer(ESC/点遮罩关闭),但样式独立,避免动 chat 那边。 */
export function ImagePreview({ name, src, size }: { name: string; src: string; size: number }) {
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    if (!expanded) return
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setExpanded(false)
    }
    window.addEventListener('keydown', handler)
    const prev = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', handler)
      document.body.style.overflow = prev
    }
  }, [expanded])

  return (
    <div className={styles.imagePreviewWrap}>
      <div className={styles.imagePreviewMeta}>
        <span className={styles.imagePreviewName}>{name}</span>
        <span className={styles.imagePreviewSize}>{formatSize(size)}</span>
        <span className={styles.imagePreviewHint}>点击图片放大</span>
      </div>
      <div className={styles.imagePreviewStage}>
        <img
          src={src}
          alt={name}
          className={styles.imagePreviewImg}
          loading="lazy"
          onClick={() => setExpanded(true)}
        />
      </div>
      {expanded && createPortal(
        <div
          className={styles.lightbox}
          onClick={() => setExpanded(false)}
          role="dialog"
          aria-modal="true"
          aria-label={name}
        >
          <img
            src={src}
            alt={name}
            className={styles.lightboxImg}
            onClick={(e) => e.stopPropagation()}
          />
          <button
            type="button"
            className={styles.lightboxClose}
            onClick={() => setExpanded(false)}
            aria-label="关闭"
          >
            ✕
          </button>
        </div>,
        document.body,
      )}
    </div>
  )
}
