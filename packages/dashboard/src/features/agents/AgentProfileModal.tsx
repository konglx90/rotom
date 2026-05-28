import { useState, useEffect } from 'react';
import type { Agent, AgentProfile } from '../../api/types';
import { agentsApi } from '../../api/agents';
import { Button } from '../../components/ui/Button';
import styles from './AddAgentModal.module.css';

interface AgentProfileModalProps {
  agent: Agent | null;
  isOpen: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export function AgentProfileModal({ agent, isOpen, onClose, onSuccess }: AgentProfileModalProps) {
  const [position, setPosition] = useState('');
  const [responsibilities, setResponsibilities] = useState('');
  const [techStack, setTechStack] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // List endpoint omits the plaintext token, so fetch it on open.
  const [token, setToken] = useState<string | null>(null);
  const [tokenLoading, setTokenLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!agent) return;
    setPosition(agent.profile?.position || '');
    setResponsibilities(agent.profile?.responsibilities || '');
    setTechStack(agent.profile?.tech_stack || '');
    setError('');
    setCopied(false);
    setToken(null);
    setTokenLoading(true);
    let cancelled = false;
    agentsApi.getById(agent.id).then((full) => {
      if (cancelled) return;
      setToken(full.token ?? null);
    }).catch(() => {
      if (cancelled) return;
      setToken(null);
    }).finally(() => {
      if (!cancelled) setTokenLoading(false);
    });
    return () => { cancelled = true };
  }, [agent]);

  if (!isOpen || !agent) return null;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    const profile: AgentProfile = {};
    if (position.trim()) profile.position = position.trim();
    if (responsibilities.trim()) profile.responsibilities = responsibilities.trim();
    if (techStack.trim()) profile.tech_stack = techStack.trim();

    try {
      const response = await fetch(`/api/agents/${agent.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile }),
      });

      const data = await response.json();
      if (data.error) {
        setError(data.error);
      } else {
        onSuccess();
        onClose();
      }
    } catch {
      setError('保存失败');
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    setError('');
    onClose();
  };

  const handleCopyToken = async () => {
    if (!token) return;
    try {
      await navigator.clipboard.writeText(token);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore — older browsers / non-https. User can still select the value manually.
    }
  };

  const tokenDisplay = tokenLoading
    ? '加载中…'
    : token ?? '未知（旧 agent 没有保存明文，请点「重置 token」生成新 token）';

  return (
    <div className={styles.overlay} onClick={handleClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h3>编辑员工介绍 — {agent.name}</h3>
          <Button variant="ghost" size="sm" iconOnly onClick={handleClose} title="关闭">&times;</Button>
        </div>

        <div className={styles.content}>
          <div className={styles.field}>
            <label>Mesh Token</label>
            <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ display: 'flex', gap: 8 }}>
                  <input
                    type="text"
                    value={tokenDisplay}
                    readOnly
                    onFocus={(e) => e.currentTarget.select()}
                    style={{
                      flex: 1,
                      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                      fontSize: '12px',
                      padding: '8px 12px',
                      borderRadius: '6px',
                      border: '1px solid #d1d5db',
                      background: '#f9fafb',
                      color: token ? '#111827' : '#9ca3af',
                      cursor: token ? 'text' : 'not-allowed',
                    }}
                  />
                  <Button
                    type="button"
                    variant="secondary"
                    size="sm"
                    onClick={handleCopyToken}
                    disabled={!token}
                    title={token ? '复制 token 到剪贴板' : '当前无可复制的明文 token'}
                  >
                    {copied ? '已复制' : '复制'}
                  </Button>
                </div>
              </div>
              <div style={{
                width: 200,
                fontSize: 12,
                color: '#6b7280',
                lineHeight: 1.5,
                padding: '6px 10px',
                borderLeft: '3px solid #e5e7eb',
              }}>
                <div style={{ fontWeight: 600, color: '#374151', marginBottom: 4 }}>关于 mesh_*</div>
                目前仅作为唯一 ID 使用，后续可作为鉴权使用。
              </div>
            </div>
          </div>

          <form onSubmit={handleSubmit}>
            <div className={styles.field}>
              <label>岗位</label>
              <input
                type="text"
                value={position}
                onChange={(e) => setPosition(e.target.value)}
                placeholder="如：前端开发工程师"
                disabled={loading}
              />
            </div>

            <div className={styles.field}>
              <label>负责</label>
              <textarea
                value={responsibilities}
                onChange={(e) => setResponsibilities(e.target.value)}
                placeholder="如：负责保险业务前端架构和核心模块开发"
                rows={3}
                disabled={loading}
                style={{ width: '100%', resize: 'vertical', padding: '8px 12px', borderRadius: '6px', border: '1px solid #d1d5db', fontSize: '14px' }}
              />
            </div>

            <div className={styles.field}>
              <label>技术栈</label>
              <input
                type="text"
                value={techStack}
                onChange={(e) => setTechStack(e.target.value)}
                placeholder="如：React, TypeScript, Node.js"
                disabled={loading}
              />
            </div>

            {error && <div style={{ color: 'var(--color-error)', fontSize: '13px', marginBottom: '12px' }}>{error}</div>}

            <div className={styles.actions}>
              <Button type="button" variant="secondary" size="md" onClick={handleClose}>
                取消
              </Button>
              <Button
                type="submit"
                variant="primary"
                size="md"
                disabled={loading}
              >
                {loading ? '保存中...' : '保存'}
              </Button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
