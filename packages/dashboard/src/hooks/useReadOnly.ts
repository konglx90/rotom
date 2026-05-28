import { useAuth } from '../context/AuthContext'

/**
 * Returns true when the dashboard is running in read-only preview mode.
 * Use this in any write-action UI to set `disabled` and an explanatory tooltip.
 * The backend's auth middleware enforces read-only independently — this hook is
 * for UX (so users see a disabled button instead of clicking and getting a 403).
 */
export function useReadOnly(): boolean {
  return useAuth().isPreview
}

/** Standardised tooltip text for read-only-disabled controls. */
export const READ_ONLY_TITLE = '预览模式下不可用'
