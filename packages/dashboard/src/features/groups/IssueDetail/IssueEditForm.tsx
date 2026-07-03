import { Button } from '../../../components/ui/Button'
import { Textarea } from '../../../components/ui/Textarea'
import styles from './IssueEditForm.module.css'
import type { IssueEditState } from './useIssueEdit'

interface IssueEditFormProps {
  edit: IssueEditState
}

export function IssueEditForm({ edit }: IssueEditFormProps) {
  return (
    <div className={styles.issueEditForm}>
      <Textarea
        label="描述 (支持 Markdown)"
        value={edit.editDescription}
        onChange={e => edit.setEditDescription(e.target.value)}
        disabled={edit.savingEdit}
        placeholder="描述（可留空）"
        rows={8}
      />
      {edit.editError && <div className={styles.issueEditError}>{edit.editError}</div>}
      <div className={styles.issueEditActions}>
        <Button variant="secondary" size="md" onClick={edit.cancelEdit} disabled={edit.savingEdit}>
          取消
        </Button>
        <Button variant="primary" size="md" onClick={edit.saveEdit} loading={edit.savingEdit}>
          {edit.savingEdit ? '保存中…' : '保存'}
        </Button>
      </div>
    </div>
  )
}
