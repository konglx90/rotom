import { useEffect, useState } from 'react';
import type { Domain } from '../../api/types';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import styles from './AddAgentModal.module.css';

interface AddAgentModalProps {
  open: boolean;
  onClose: () => void;
  domains: Domain[];
  onSuccess: () => void;
  defaultDomain?: string;
}

interface AgentConfig {
  master: string;
  name: string;
  token: string;
  description?: string;
  profile?: {
    position?: string;
    responsibilities?: string;
    tech_stack?: string;
    category?: string;
  };
}

export function AddAgentModal({ open, onClose, domains, onSuccess, defaultDomain }: AddAgentModalProps) {
  const [name, setName] = useState('');
  const [domain, setDomain] = useState(defaultDomain ?? '');
  const [category, setCategory] = useState('');
  const [position, setPosition] = useState('');
  const [responsibilities, setResponsibilities] = useState('');
  const [techStack, setTechStack] = useState('');
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [result, setResult] = useState<{ success: boolean; config?: AgentConfig; error?: string } | null>(null);

  useEffect(() => {
    if (open) {
      setDomain(defaultDomain ?? '');
    }
  }, [open, defaultDomain]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !domain) {
      setResult({ success: false, error: '请填写完整信息' });
      return;
    }

    setLoading(true);
    try {
      const profileObj: Record<string, string> = {};
      if (category) profileObj.category = category;
      if (position.trim()) profileObj.position = position.trim();
      if (responsibilities.trim()) profileObj.responsibilities = responsibilities.trim();
      if (techStack.trim()) profileObj.tech_stack = techStack.trim();

      const response = await fetch('/api/agents', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: name.trim(),
          domain,
          ...(Object.keys(profileObj).length > 0 ? { profile: profileObj } : {}),
        })
      });

      const data = await response.json();

      if (data.error) {
        setResult({ success: false, error: data.error });
      } else {
        const baseConfig = data.configTemplate?.channels?.['a2a-gateway'] || {
          master: window.location.origin.replace('http', 'ws'),
          name: name.trim(),
          token: data.token
        };

        if (Object.keys(profileObj).length > 0) {
          baseConfig.profile = profileObj;
        }

        setResult({
          success: true,
          config: baseConfig
        });
        onSuccess();
      }
    } catch (error) {
      setResult({ success: false, error: '网络请求失败' });
    } finally {
      setLoading(false);
    }
  };

  const copyConfig = () => {
    if (result?.config) {
      const text = JSON.stringify(result.config, null, 2);

      const copyText = () => {
        navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }).catch(() => {
          // Fallback for older browsers
          const textarea = document.createElement('textarea');
          textarea.value = text;
          textarea.style.position = 'fixed';
          textarea.style.left = '-9999px';
          document.body.appendChild(textarea);
          textarea.select();
          try {
            document.execCommand('copy');
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
          } catch {
            alert('复制失败，请手动复制');
          }
          document.body.removeChild(textarea);
        });
      };

      copyText();
    }
  };

  const handleClose = () => {
    setName('');
    setDomain('');
    setCategory('');
    setPosition('');
    setResponsibilities('');
    setTechStack('');
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
      {domains.length === 0 && (
        <div className={styles.warning}>
          请先在「部门」中创建至少一个域。
        </div>
      )}

      {!result ? (
        <form onSubmit={handleSubmit}>
          <div className={styles.field}>
            <label>节点名称 *</label>
            <input
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="如：小七"
              disabled={loading}
            />
          </div>

          <div className={styles.field}>
            <label>所属域 *</label>
            <select
              value={domain}
              onChange={(e) => setDomain(e.target.value)}
              disabled={loading || domains.length === 0}
            >
              <option value="">选择域</option>
              {domains.map((d) => (
                <option key={d.id} value={d.name}>
                  {d.name}{d.description ? ` — ${d.description}` : ''}
                </option>
              ))}
            </select>
          </div>

          <div className={styles.field}>
            <label>员工类型</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              disabled={loading}
            >
              <option value="">🚀 Agent（默认）</option>
              <option value="真人">👤 真人 — 真实人类团队成员</option>
            </select>
          </div>

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
            <input
              type="text"
              value={responsibilities}
              onChange={(e) => setResponsibilities(e.target.value)}
              placeholder="如：负责保险业务前端架构和核心模块开发"
              disabled={loading}
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

          <div className={styles.actions}>
            <Button type="button" variant="secondary" size="md" onClick={handleClose}>
              取消
            </Button>
            <Button
              type="submit"
              variant="primary"
              size="md"
              disabled={loading || domains.length === 0}
            >
              {loading ? '生成中...' : '生成 Token'}
            </Button>
          </div>
        </form>
      ) : (
        <div className={styles.success}>
          {result.success ? (
            <>
              <div className={styles.successIcon}>✓</div>
              <h4>注册成功</h4>

              <div className={styles.configSection}>
                <p className={styles.configLabel}>
                  将以下配置发给对方，添加到 openclaw.json 的 channels 中：
                </p>
                <div className={styles.configContainer}>
                  <pre className={styles.configJson}>
                    {JSON.stringify(result.config, null, 2)}
                  </pre>
                  <Button
                    onClick={copyConfig}
                    variant={copied ? 'success' : 'secondary'}
                    size="sm"
                    type="button"
                  >
                    {copied ? '已复制' : '复制配置'}
                  </Button>
                </div>
                <div className={styles.info}>
                  对方粘贴配置后启动 Gateway 即可自动连接。<br />
                  profile 中的岗位、负责、技术栈会帮助其他数字员工了解该员工角色。
                </div>
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
