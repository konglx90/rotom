/**
 * 图册 Tab —— 工具箱里跨群汇总展示所有上传过的图片。
 *
 * 数据来自后端 `GET /api/uploads`(扫 ~/.rotom/uploads 目录,无 DB 索引)。
 * 只读:不在这里上传,也不删除,避免破坏历史聊天里嵌的 ![x](url) 引用。
 * 上传仍在群聊里完成(GroupChatArea 的 paste/drop/input),图册只做汇总查看。
 */

import { useCallback, useEffect, useState } from 'react'
import { Modal } from '../../components/ui/Modal/Modal'
import { Button } from '../../components/ui/Button'
import { Select } from '../../components/ui/Select'
import { uploadsApi, type UploadItem } from '../../api/uploads'
import { groupsApi } from '../../api/groups'
import type { Group } from '../../api/types'
import styles from './ManagementTab.module.css'

interface GalleryRow extends UploadItem {}

function formatTime(ts: string): string {
  const n = Date.parse(ts)
  if (!Number.isFinite(n)) return ts
  return new Date(n).toLocaleString('zh-CN', { hour12: false })
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

export function ImageGalleryTab() {
  const [groups, setGroups] = useState<Group[]>([])
  const [selectedGroupId, setSelectedGroupId] = useState<string>('')
  const [items, setItems] = useState<GalleryRow[]>([])
  const [cursor, setCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [viewing, setViewing] = useState<GalleryRow | null>(null)
  const [copyHint, setCopyHint] = useState<string>('')

  // 群列表用于筛选下拉
  useEffect(() => {
    groupsApi.list().then((gs: Group[] | null) => setGroups(gs ?? [])).catch(() => {})
  }, [])

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const res = await uploadsApi.list({
        groupId: selectedGroupId || undefined,
        limit: 60,
      })
      setItems(res.items)
      setCursor(res.nextCursor)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setItems([])
      setCursor(null)
    } finally {
      setLoading(false)
    }
  }, [selectedGroupId])

  useEffect(() => { reload() }, [reload])

  const loadMore = async () => {
    if (!cursor || loadingMore) return
    setLoadingMore(true)
    setError(null)
    try {
      const res = await uploadsApi.list({
        groupId: selectedGroupId || undefined,
        limit: 60,
        cursor,
      })
      setItems((prev) => [...prev, ...res.items])
      setCursor(res.nextCursor)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoadingMore(false)
    }
  }

  const copyLink = async (item: GalleryRow) => {
    const full = `${window.location.origin}${item.url}`
    try {
      await navigator.clipboard.writeText(full)
      setCopyHint('已复制 ✓')
      setTimeout(() => setCopyHint(''), 1500)
    } catch {
      setCopyHint('复制失败,请手动选中地址栏')
      setTimeout(() => setCopyHint(''), 2500)
    }
  }

  if (loading && items.length === 0) {
    return <div className={styles.container}>加载中...</div>
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.headerText}>
          <h2 className={styles.heading}>图册</h2>
          <p className={styles.subheading}>
            跨群汇总所有上传过的图片。点击预览大图,可复制链接。
            上传请在群聊里完成(粘贴/拖拽/选择文件),这里只做查看。
          </p>
        </div>
        <Select
          size="sm"
          style={{ width: 220 }}
          value={selectedGroupId}
          onChange={(e) => setSelectedGroupId(e.target.value)}
          options={[
            { value: '', label: '— 全部群 —' },
            ...groups.map((g) => ({
              value: g.id,
              label: `${g.name}${g.archived_at ? ' (已归档)' : ''}`,
            })),
          ]}
        />
      </div>

      {error && (
        <div style={{ padding: 12, background: 'rgba(255,80,80,0.08)', color: '#c33', borderRadius: 8, fontSize: 13 }}>
          {error}
        </div>
      )}

      {items.length === 0 && !loading && !error && (
        <div className={styles.empty}>还没有上传过图片</div>
      )}

      {items.length > 0 && (
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
          gap: 12,
        }}>
          {items.map((it) => (
            <button
              key={`${it.groupId}/${it.fileName}`}
              onClick={() => setViewing(it)}
              style={{
                display: 'flex',
                flexDirection: 'column',
                padding: 0,
                border: '1px solid rgba(0,0,0,0.08)',
                borderRadius: 8,
                background: '#fff',
                cursor: 'pointer',
                textAlign: 'left',
                overflow: 'hidden',
              }}
            >
              <div style={{
                width: '100%',
                aspectRatio: '1 / 1',
                background: 'rgba(0,0,0,0.04)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                overflow: 'hidden',
              }}>
                <img
                  src={it.url}
                  alt={it.fileName}
                  loading="lazy"
                  style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                />
              </div>
              <div style={{ padding: '6px 8px', fontSize: 11, color: '#666', lineHeight: 1.4 }}>
                <div style={{ fontWeight: 600, color: '#333', marginBottom: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {it.groupName}
                </div>
                <div style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {formatTime(it.createdAt).split(' ')[0]} · {formatSize(it.size)}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}

      {cursor && (
        <div style={{ display: 'flex', justifyContent: 'center', marginTop: 12 }}>
          <Button variant="secondary" size="sm" onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? '加载中...' : '加载更多'}
          </Button>
        </div>
      )}

      <Modal
        open={!!viewing}
        title={viewing ? viewing.fileName : ''}
        onClose={() => setViewing(null)}
        size="xl"
      >
        {viewing && (
          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 240px', gap: 16, alignItems: 'start' }}>
            <div style={{ background: 'rgba(0,0,0,0.03)', borderRadius: 8, padding: 12, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 300 }}>
              <img
                src={viewing.url}
                alt={viewing.fileName}
                style={{ maxWidth: '100%', maxHeight: '70vh', objectFit: 'contain' }}
              />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, fontSize: 13, lineHeight: 1.6 }}>
              <div><strong>群</strong><br />{viewing.groupName}</div>
              <div><strong>上传时间</strong><br />{formatTime(viewing.createdAt)}</div>
              <div><strong>大小</strong><br />{formatSize(viewing.size)}</div>
              <div><strong>类型</strong><br />{viewing.mimeType}</div>
              <div style={{ wordBreak: 'break-all' }}>
                <strong>文件名</strong><br />
                <code style={{ fontSize: 11 }}>{viewing.fileName}</code>
              </div>
              <div style={{ wordBreak: 'break-all' }}>
                <strong>链接</strong><br />
                <code style={{ fontSize: 11 }}>{window.location.origin}{viewing.url}</code>
              </div>
              <Button variant="secondary" size="sm" onClick={() => copyLink(viewing)}>
                复制链接
              </Button>
              {copyHint && <div style={{ fontSize: 12, color: '#2f7a2f' }}>{copyHint}</div>}
            </div>
          </div>
        )}
      </Modal>
    </div>
  )
}
