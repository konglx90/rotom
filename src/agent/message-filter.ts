/**
 * Digital Employee Mesh — Message filter
 *
 * allowFrom / blockFrom whitelist/blacklist for incoming messages.
 * If allowFrom is set, only listed agents can send messages.
 * If blockFrom is set, listed agents are rejected.
 * allowFrom takes precedence over blockFrom.
 */

export interface FilterConfig {
  allowFrom?: string[];  // Agent names (whitelist)
  blockFrom?: string[];  // Agent names (blacklist)
}

export class MessageFilter {
  private allow: Set<string> | null;
  private block: Set<string>;

  constructor(config: FilterConfig = {}) {
    this.allow = config.allowFrom ? new Set(config.allowFrom) : null;
    this.block = new Set(config.blockFrom || []);
  }

  /** Returns true if the message from this agent should be accepted. */
  accepts(fromName: string): boolean {
    // Whitelist mode: only accept listed agents
    if (this.allow) {
      return this.allow.has(fromName);
    }
    // Blacklist mode: reject listed agents
    return !this.block.has(fromName);
  }
}
