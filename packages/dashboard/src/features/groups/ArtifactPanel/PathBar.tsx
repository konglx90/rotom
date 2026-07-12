// 选中文件路径条:展示绝对路径 + 操作按钮(在 VSCode 打开 / 复制路径 / 关闭预览)。
// 从 ArtifactPanel/index.tsx 抽出,纯展示型。父组件在 root 存在时渲染。
import type { ArtifactFile } from '../../../api/types'
import { Button } from '../../../components/ui/Button'
import styles from './ArtifactPanel.module.css'

interface PathBarProps {
  root: string
  selectedFile: ArtifactFile | null
  absolutePath: string
  vscodeError: string | null
  isVisitor: boolean
  vscodeLoading: boolean
  onOpenVscode: (filePath?: string, repo?: string) => void
  onCopyPath: () => void
  copiedHint: boolean
  onClose: () => void
}

export function PathBar({
  root,
  selectedFile,
  absolutePath,
  vscodeError,
  isVisitor,
  vscodeLoading,
  onOpenVscode,
  onCopyPath,
  copiedHint,
  onClose,
}: PathBarProps) {
  return (
    <div className={styles.pathBar}>
      <span className={styles.pathBarPath} title={selectedFile ? absolutePath : root}>
        {selectedFile ? absolutePath : root}
      </span>
      {selectedFile && (
        <div className={styles.pathBarActions}>
          {vscodeError && (
            <span className={styles.vscodeError} title={vscodeError}>{vscodeError}</span>
          )}
          {!isVisitor && (
            <Button
              variant="ghost"
              size="sm"
              onClick={() => onOpenVscode(selectedFile.path)}
              disabled={vscodeLoading}
              title="在 master 本机用 VSCode 打开该文件"
            >
              {vscodeLoading ? 'VSCode…' : 'VSCode'}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            onClick={onCopyPath}
            title="复制绝对路径"
          >
            {copiedHint ? '已复制' : '复制'}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={onClose}
            title="关闭预览"
          >
            关闭
          </Button>
        </div>
      )}
    </div>
  )
}
