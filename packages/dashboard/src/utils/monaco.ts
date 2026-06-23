// Monaco (2.5 MB / 654 KB gzipped) is only needed by ArtifactPanel/ApprovalCard,
// so we defer loading the whole module until the first editor mount. The
// `ensureMonaco` call is idempotent — concurrent callers share one promise.
import type * as monaco from 'monaco-editor'

let setupPromise: Promise<typeof monaco> | null = null

export function ensureMonaco() {
  if (!setupPromise) {
    setupPromise = import('./monaco-setup').then((m) => m.default)
  }
  return setupPromise
}