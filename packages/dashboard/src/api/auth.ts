import { api } from './client'
import type { LoginResponse } from './types'

/**
 * Authentication API
 */
export const authApi = {
  /**
   * Login with username and password
   */
  async login(username: string, password: string): Promise<LoginResponse> {
    return api.post<LoginResponse>('/login', { username, password })
  },

  /**
   * Enter preview mode (no credentials). Returns a read-only JWT —
   * the server's auth middleware accepts it for GET only and 403s on writes.
   */
  async previewLogin(): Promise<LoginResponse> {
    return api.post<LoginResponse>('/preview-login')
  },

  /**
   * Change current user's password
   */
  async changePassword(oldPassword: string, newPassword: string): Promise<{ ok: boolean }> {
    return api.post<{ ok: boolean }>('/change-password', {
      oldPassword,
      newPassword,
    })
  },

  /**
   * Logout (clear token on client side)
   */
  logout(): void {
    api.clearToken()
  },
}
