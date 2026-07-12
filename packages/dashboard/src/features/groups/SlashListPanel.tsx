// GroupChatArea 的 slash 命令列表面板(/issue、/note、/schedule 的选择 UI)。
// 从 GroupChatArea.tsx 抽出。纯 props 驱动 + 本地 scrollIntoView。
import { useRef, useEffect, type ReactNode } from 'react'
import type { Issue, Note, Schedule } from '../../api/types'
import type { SlashListData } from './slashCommands'
import styles from './ChatArea.module.css'

function formatTime(ms: number): string {
  const d = new Date(ms)
  return d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
}

interface SlashListPanelProps {
  data: SlashListData
  selectedIndex: number
  setSelectedIndex: (i: number) => void
  onSelect: (index: number) => void
  onClose: () => void
}

export function SlashListPanel({ data, selectedIndex, setSelectedIndex, onSelect, onClose }: SlashListPanelProps) {
  const title = data.kind === 'issue' ? 'Issues'
    : data.kind === 'schedule' ? 'Schedules'
    : 'Notes'
  const itemRefs = useRef<(HTMLDivElement | null)[]>([])
  useEffect(() => {
    const el = itemRefs.current[selectedIndex]
    if (el) el.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])
  const renderRow = (key: string, idx: number, children: ReactNode) => (
    <div
      key={key}
      ref={el => { itemRefs.current[idx] = el }}
      className={`${styles.slashListRow} ${idx === selectedIndex ? styles.slashListRowActive : ''}`}
      onMouseEnter={() => setSelectedIndex(idx)}
      onClick={() => onSelect(idx)}
    >
      {children}
    </div>
  )
  return (
    <div className={styles.slashListPanel}>
      <div className={styles.slashListHeader}>
        <span className={styles.slashListTitle}>{title} ({data.items.length}) · Enter 引用 · Esc 关闭</span>
        <button type="button" className={styles.slashListClose} onClick={onClose} aria-label="关闭">✕</button>
      </div>
      <div className={styles.slashListBody}>
        {data.items.length === 0 ? (
          <div className={styles.slashListEmpty}>暂无{data.kind === 'issue' ? ' issue' : data.kind === 'schedule' ? '定时任务' : ' note'}</div>
        ) : data.kind === 'issue' ? (
          (data.items as Issue[]).map((it, idx) => renderRow(it.id, idx, (
            <>
              <div className={styles.slashListRowTitle}>{it.title || it.description.slice(0, 60) || '(无标题)'}</div>
              <div className={styles.slashListRowMeta}>
                <span className={styles.slashBadge}>{it.status}</span>
                {it.assigned_to && <span>→ {it.assigned_to}</span>}
                <span className={styles.slashListRowTime}>{new Date(it.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</span>
              </div>
            </>
          )))
        ) : data.kind === 'schedule' ? (
          (data.items as Schedule[]).map((it, idx) => renderRow(String(it.id), idx, (
            <>
              <div className={styles.slashListRowTitle}>{it.name}</div>
              <div className={styles.slashListRowMeta}>
                <span className={styles.slashBadge}>{it.mode}</span>
                <span>{it.schedule_kind === 'once' ? (it.run_at ? formatTime(it.run_at) : '未排期') : `每 ${it.interval_sec}s`}</span>
                {it.agent_name && <span>→ {it.agent_name}</span>}
                <span className={styles.slashListRowTime}>{it.enabled ? 'on' : 'off'}</span>
              </div>
              <div className={styles.slashListRowDesc}>{it.prompt}</div>
            </>
          )))
        ) : (
          (data.items as Note[]).map((it, idx) => renderRow(it.id, idx, (
            <>
              <div className={styles.slashListRowTitle}>{it.title}</div>
              {it.description && <div className={styles.slashListRowDesc}>{it.description}</div>}
              <div className={styles.slashListRowMeta}>
                <span className={styles.slashBadge}>note</span>
                <span>{it.created_by}</span>
                <span className={styles.slashListRowTime}>{new Date(it.created_at).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}</span>
              </div>
            </>
          )))
        )}
      </div>
    </div>
  )
}
