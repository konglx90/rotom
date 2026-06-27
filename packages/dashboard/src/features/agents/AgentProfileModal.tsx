import { useState, useEffect, useRef } from 'react';
import { Avatar } from '../../components/ui/Avatar';
import type { Agent, AgentProfile } from '../../api/types';
import { agentsApi } from '../../api/agents';
import { Button } from '../../components/ui/Button';
import { Modal } from '../../components/ui/Modal';
import styles from './AddAgentModal.module.css';

interface AgentProfileModalProps {
  agent: Agent | null;
  open: boolean;
  onClose: () => void;
  onSuccess: () => void;
}

export function AgentProfileModal({ agent, open, onClose, onSuccess }: AgentProfileModalProps) {
  const [position, setPosition] = useState('');
  const [responsibilities, setResponsibilities] = useState('');
  const [techStack, setTechStack] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  // List endpoint omits the plaintext token, so fetch it on open.
  const [token, setToken] = useState<string | null>(null);
  const [tokenLoading, setTokenLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [avatarPreview, setAvatarPreview] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!agent) return;
    setPosition(agent.profile?.position || '');
    setResponsibilities(agent.profile?.responsibilities || '');
    setTechStack(agent.profile?.tech_stack || '');
    setAvatarUrl(agent.avatar_url ?? null);
    setAvatarPreview(null);
    setAvatarFile(null);
    setError('');
    setCopied(false);
    setToken(null);
    setTokenLoading(true);
    let cancelled = false;
    agentsApi.getById(agent.id).then((full) => {
      if (cancelled) return;
      setToken(full.token ?? null);
      if (full.avatar_url && !cancelled) setAvatarUrl(full.avatar_url);
    }).catch(() => {
      if (cancelled) return;
      setToken(null);
    }).finally(() => {
      if (!cancelled) setTokenLoading(false);
    });
    return () => { cancelled = true };
  }, [agent]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!agent) return;
    setLoading(true);
    setError('');

    const profile: AgentProfile = {};
    if (position.trim()) profile.position = position.trim();
    if (responsibilities.trim()) profile.responsibilities = responsibilities.trim();
    if (techStack.trim()) profile.tech_stack = techStack.trim();

    // Handle avatar upload first if a file was selected
    let finalAvatarUrl = avatarUrl;
    if (avatarFile) {
      setUploading(true);
      try {
        const reader = new FileReader();
        const result = await new Promise<string>((resolve, reject) => {
          reader.onload = () => {
            const dataUrl = reader.result as string;
            const base64 = dataUrl.split(',')[1];
            resolve(base64);
          };
          reader.onerror = reject;
          reader.readAsDataURL(avatarFile);
        });
        const uploadResult = await agentsApi.uploadAvatar(agent.id, result, avatarFile.type);
        finalAvatarUrl = uploadResult.url;
        setAvatarUrl(uploadResult.url);
        setAvatarPreview(null);
        setAvatarFile(null);
      } catch (err) {
        setError('头像上传失败');
        setUploading(false);
        return;
      } finally {
        setUploading(false);
      }
    }

    try {
      const body: Record<string, unknown> = { profile };
      if (finalAvatarUrl !== (agent.avatar_url ?? null)) {
        body.avatar_url = finalAvatarUrl;
      }
      const response = await fetch(`/api/agents/${agent.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
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
    setAvatarPreview(null);
    setAvatarFile(null);
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
    <Modal
      open={open && !!agent}
      title={agent ? `编辑员工介绍 — ${agent.name}` : '编辑员工介绍'}
      onClose={handleClose}
      size="md"
    >
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

      {/* Avatar section */}
      <div className={styles.field}>
        <label>头像</label>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          <div style={{ position: 'relative' }}>
            {avatarPreview ? (
              <img
                src={avatarPreview}
                alt="预览"
                style={{ width: 64, height: 64, borderRadius: '50%', objectFit: 'cover' }}
              />
            ) : avatarUrl ? (
              <img
                src={avatarUrl}
                alt={agent?.name ?? ''}
                style={{ width: 64, height: 64, borderRadius: '50%', objectFit: 'cover' }}
                onError={(e) => {
                  // On error, let the Avatar component handle it
                  (e.target as HTMLImageElement).style.display = 'none';
                }}
              />
            ) : agent ? (
              <Avatar name={agent.name} size={64} />
            ) : null}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <input
              ref={fileInputRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              style={{ display: 'none' }}
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) {
                  setAvatarFile(file);
                  const reader = new FileReader();
                  reader.onload = () => setAvatarPreview(reader.result as string);
                  reader.readAsDataURL(file);
                }
              }}
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={loading || uploading}
            >
              {uploading ? '上传中...' : '上传头像'}
            </Button>
            {(avatarPreview || avatarUrl) && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => {
                  setAvatarFile(null);
                  setAvatarPreview(null);
                  setAvatarUrl(null);
                }}
                disabled={loading || uploading}
              >
                清除头像
              </Button>
            )}
          </div>
        </div>
        <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 6 }}>
          支持 PNG / JPG / GIF / WebP，最大 2MB
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
            disabled={loading || uploading}
          />
        </div>

        <div className={styles.field}>
          <label>负责</label>
          <textarea
            value={responsibilities}
            onChange={(e) => setResponsibilities(e.target.value)}
            placeholder="如：负责保险业务前端架构和核心模块开发"
            rows={3}
            disabled={loading || uploading}
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
            disabled={loading || uploading}
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
            disabled={loading || uploading}
          >
            {loading || uploading ? '保存中...' : '保存'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}
