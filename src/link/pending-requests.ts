/**
 * PendingRequests —— rotom-link 端的 requestId → Promise 映射。
 *
 * CLI 调 POST /fed/ask 时,daemon 生成 requestId,记录到这里,调
 * fedClient.route(requestId, ...),然后 await promise。
 *
 * 协调 master 把 FedReply 广播回来,handleReply 用 requestId 解对应 promise。
 * 5min 超时(对齐 src/cli/ask.ts 的 bridge 超时)避免内存泄漏。
 */

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

interface Pending {
  resolve: (message: string) => void;
  reject: (err: Error) => void;
  createdAt: number;
  timer: NodeJS.Timeout;
}

export class PendingRequests {
  private map = new Map<string, Pending>();
  private timeoutMs: number;

  constructor(timeoutMs: number = DEFAULT_TIMEOUT_MS) {
    this.timeoutMs = timeoutMs;
  }

  register(requestId: string): { promise: Promise<string>; cancel: (err: Error) => void } {
    let resolve!: (message: string) => void;
    let reject!: (err: Error) => void;
    const promise = new Promise<string>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    const timer = setTimeout(() => {
      if (this.map.has(requestId)) {
        this.map.delete(requestId);
        reject(new Error(`fed ask timeout after ${this.timeoutMs}ms (requestId=${requestId})`));
      }
    }, this.timeoutMs);

    this.map.set(requestId, { resolve, reject, createdAt: Date.now(), timer });

    return {
      promise,
      cancel: (err: Error) => {
        const p = this.map.get(requestId);
        if (p) {
          clearTimeout(p.timer);
          this.map.delete(requestId);
          reject(err);
        }
      },
    };
  }

  resolve(requestId: string, message: string): boolean {
    const p = this.map.get(requestId);
    if (!p) return false;
    clearTimeout(p.timer);
    this.map.delete(requestId);
    p.resolve(message);
    return true;
  }

  reject(requestId: string, err: Error): boolean {
    const p = this.map.get(requestId);
    if (!p) return false;
    clearTimeout(p.timer);
    this.map.delete(requestId);
    p.reject(err);
    return true;
  }

  /** daemon 关停时拒绝所有 pending,避免 CLI hang */
  rejectAll(err: Error): void {
    for (const [, p] of this.map) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.map.clear();
  }

  size(): number {
    return this.map.size;
  }
}
