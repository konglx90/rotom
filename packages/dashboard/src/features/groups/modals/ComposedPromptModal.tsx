import { Modal } from '../../../components/ui/Modal/Modal'
import type { ComposedPrompt } from '../../../api/groups'

interface Props {
  open: boolean
  /** 哪条消息的 prompt —— 只是给弹窗标题用,渲染用的是 composedPrompt 本身。 */
  messageLabel?: string
  composedPrompt: ComposedPrompt
  onClose: () => void
}

const LAYER_LABELS: Record<ComposedPrompt['layers'][number]['layer'], string> = {
  'rotom-cli': 'rotom-cli',
  'agent-role': 'agent-role',
  'group-basic': 'group-basic',
  'group-guidance': 'group-guidance',
  cwd: 'cwd',
  task: 'task',
}

export function ComposedPromptModal({ open, messageLabel, composedPrompt, onClose }: Props) {
  return (
    <Modal
      open={open}
      title={messageLabel ? `该消息的 prompt 构成 · ${messageLabel}` : '该消息的 prompt 构成'}
      onClose={onClose}
    >
      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 0 12px' }}>
        <div style={{ fontSize: 12, color: 'var(--color-text-secondary, #666)' }}>
          生成时间: {composedPrompt.generated_at} · 版本: {composedPrompt.prompt_version}
        </div>

        {composedPrompt.layers.map((layer, idx) => (
          <details
            key={`${layer.layer}-${idx}`}
            open={idx === 0}
            style={{
              border: '1px solid var(--color-border, #e5e7eb)',
              borderRadius: 6,
              padding: '8px 12px',
              background: 'var(--color-bg-secondary, #fafafa)',
            }}
          >
            <summary
              style={{
                cursor: 'pointer',
                fontSize: 13,
                fontWeight: 600,
                color: 'var(--color-navy, #1f2937)',
                listStyle: 'none',
                userSelect: 'none',
              }}
            >
              <span style={{ marginRight: 8 }}>▶</span>
              Layer: {LAYER_LABELS[layer.layer] || layer.layer}
              {layer.layer === 'rotom-cli' && (
                <span style={{ marginLeft: 8, color: 'var(--color-text-secondary, #6b7280)', fontWeight: 400 }}>
                  [{composedPrompt.prompt_version}]
                </span>
              )}
            </summary>
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--color-text-secondary, #6b7280)' }}>
              source: {layer.source}
            </div>
            <pre
              style={{
                margin: '8px 0 0',
                padding: 10,
                background: '#0b1020',
                color: '#e5e7eb',
                borderRadius: 4,
                fontSize: 12,
                lineHeight: 1.55,
                maxHeight: 320,
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
              }}
            >
              {layer.content}
            </pre>
          </details>
        ))}

        <details
          style={{
            border: '1px solid var(--color-border, #e5e7eb)',
            borderRadius: 6,
            padding: '8px 12px',
            background: 'var(--color-bg-secondary, #fafafa)',
          }}
        >
          <summary
            style={{
              cursor: 'pointer',
              fontSize: 13,
              fontWeight: 600,
              color: 'var(--color-navy, #1f2937)',
              listStyle: 'none',
              userSelect: 'none',
            }}
          >
            <span style={{ marginRight: 8 }}>▶</span>
            final (拼好的完整 prompt)
          </summary>
          <pre
            style={{
              margin: '8px 0 0',
              padding: 10,
              background: '#0b1020',
              color: '#e5e7eb',
              borderRadius: 4,
              fontSize: 12,
              lineHeight: 1.55,
              maxHeight: 480,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            }}
          >
            {composedPrompt.final}
          </pre>
        </details>
      </div>
    </Modal>
  )
}
