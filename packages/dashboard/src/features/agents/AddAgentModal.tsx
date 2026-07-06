import { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Input } from '../../components/ui/Input';
import { Modal } from '../../components/ui/Modal';
import { Select } from '../../components/ui/Select';
import styles from './AddAgentModal.module.css';

interface AddAgentModalProps {
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export function AddAgentModal({ open, onClose, onSuccess }: AddAgentModalProps) {
  const [name, setName] = useState('');
  const [category, setCategory] = useState('');
  const [position, setPosition] = useState('');
  const [bio, setBio] = useState('');
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState<{ success: boolean; error?: string } | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim()) {
      setResult({ success: false, error: '请填写节点名称' });
      return;
    }

    setLoading(true);
    try {
      const profileObj: Record<string, string> = {};
      if (category) profileObj.category = category;
      if (position.trim()) profileObj.position = position.trim();
      if (bio.trim()) profileObj.bio = bio.trim();

      const response = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          ...(Object.keys(profileObj).length > 0 ? { profile: profileObj } : {}),
        })
      });

      const data = await response.json();

      if (data.error) {
        setResult({ success: false, error: data.error });
      } else {
        // OPC 模式下本机连接即信任,无需 token / configTemplate 分发。
        // 显示简单成功提示即可,agent 已加入 DB,本机所有 executor 立即可见。
        setResult({ success: true });
        onSuccess();
      }
    } catch (error) {
      setResult({ success: false, error: '网络请求失败' });
    } finally {
      setLoading(false);
    }
  };

  const handleClose = () => {
    setName('');
    setCategory('');
    setPosition('');
    setBio('');
    setResult(null);
    onClose();
  };

  return (
    <Modal
      open={open}
      title="添加数字员工"
      onClose={handleClose}
      size="md"
    >
      {!result ? (
        <form onSubmit={handleSubmit}>
          <div className={styles.field}>
            <Input
              label="节点名称"
              required
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如：小七"
              disabled={loading}
            />
          </div>

          <div className={styles.field}>
            <Select
              label="员工类型"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              disabled={loading}
              options={[
                { value: '', label: '🚀 Agent（默认）' },
                { value: '真人', label: '👤 真人 — 真实人类团队成员' },
              ]}
            />
          </div>

          <div className={styles.field}>
            <Input
              label="岗位"
              value={position}
              onChange={(e) => setPosition(e.target.value)}
              placeholder="如：前端开发工程师"
              disabled={loading}
            />
          </div>

          <div className={styles.field}>
            <Input
              label="简介"
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              placeholder="如：负责保险业务前端架构和核心模块开发"
              disabled={loading}
            />
          </div>

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
              {loading ? '添加中...' : '添加员工'}
            </Button>
          </div>
        </form>
      ) : (
        <div className={styles.success}>
          {result.success ? (
            <>
              <div className={styles.successIcon}>✓</div>
              <h4>已添加</h4>
              <div className={styles.info} style={{ textAlign: 'center', padding: '8px 0 16px' }}>
                员工已创建。本机所有 executor 走 loopback 信任,自动可见 — 无需 token 配置。
              </div>

              <div className={styles.actions}>
                <Button variant="secondary" size="md" onClick={handleClose}>
                  关闭
                </Button>
              </div>
            </>
          ) : (
            <div className={styles.errorMsg}>
              {result.error}
              <Button variant="ghost" size="sm" onClick={() => setResult(null)}>
                重试
              </Button>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
