import { useState, useEffect } from 'react';
import type { Agent, AgentProfile } from '../../api/types';
import { Button } from '../../components/ui/Button';
import { authFetch } from '../../utils/authFetch';
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

  useEffect(() => {
    if (agent) {
      setPosition(agent.profile?.position || '');
      setResponsibilities(agent.profile?.responsibilities || '');
      setTechStack(agent.profile?.tech_stack || '');
      setError('');
    }
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
      const response = await authFetch(`/api/agents/${agent.id}`, {
        method: 'PUT',
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

  return (
    <div className={styles.overlay} onClick={handleClose}>
      <div className={styles.modal} onClick={(e) => e.stopPropagation()}>
        <div className={styles.header}>
          <h3>编辑员工介绍 — {agent.name}</h3>
          <Button variant="ghost" size="sm" iconOnly onClick={handleClose} title="关闭">&times;</Button>
        </div>

        <div className={styles.content}>
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
