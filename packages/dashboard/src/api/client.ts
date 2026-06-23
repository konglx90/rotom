/**
 * API Client for A2A Gateway Dashboard
 *
 * Dashboard endpoints are open (no auth). Agent-token-authed endpoints
 * (whoami / send-as-me) live on separate fetch paths that inject mesh_*
 * headers explicitly.
 *
 * Visitor mode: when the URL carries `?share=<token>`, the fetcher prefixes
 * the path with `/share/<token>` so requests hit the read-only visitor
 * endpoints (see src/master/api/share.ts). Mutating methods still work but
 * the visitor UI never calls them — the backend would also 401/404 them
 * since share routes only expose GETs.
 */

function getShareTokenFromUrl(): string | null {
  if (typeof window === 'undefined') return null
  const params = new URLSearchParams(window.location.search)
  return params.get('share')
}

export class ApiClient {
  private baseUrl: string

  constructor(baseUrl: string = '/api') {
    this.baseUrl = baseUrl
  }

  /**
   * Resolve a logical path like `/groups/:id/messages` into a fully-qualified
   * URL. If a share token is present in the URL, the path is rerouted under
   * `/share/:token` so it hits the visitor endpoints.
   */
  private resolveUrl(path: string): string {
    const token = getShareTokenFromUrl()
    const cleanPath = path.startsWith('/') ? path : `/${path}`
    if (token) {
      return `${this.baseUrl}/share/${token}${cleanPath}`
    }
    return `${this.baseUrl}${cleanPath}`
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string>),
    }

    try {
      const response = await fetch(this.resolveUrl(endpoint), {
        ...options,
        headers,
      })

      let data: T | undefined
      const text = await response.text()
      if (text) {
        try {
          data = JSON.parse(text)
        } catch {
          throw new Error(`Server returned non-JSON response (HTTP ${response.status})`)
        }
      }

      if (!response.ok) {
        throw new Error(
          (data as Record<string, string>)?.error || `HTTP ${response.status}: ${response.statusText}`
        )
      }

      return data as T
    } catch (error) {
      if (error instanceof Error) {
        throw error
      }
      throw new Error('Network error: Failed to connect to the server')
    }
  }

  async get<T>(endpoint: string): Promise<T> {
    return this.request<T>(endpoint, { method: 'GET' })
  }

  async post<T>(endpoint: string, data?: unknown): Promise<T> {
    return this.request<T>(endpoint, {
      method: 'POST',
      body: data ? JSON.stringify(data) : undefined,
    })
  }

  async put<T>(endpoint: string, data?: unknown): Promise<T> {
    return this.request<T>(endpoint, {
      method: 'PUT',
      body: data ? JSON.stringify(data) : undefined,
    })
  }

  async patch<T>(endpoint: string, data?: unknown): Promise<T> {
    return this.request<T>(endpoint, {
      method: 'PATCH',
      body: data ? JSON.stringify(data) : undefined,
    })
  }

  async delete<T>(endpoint: string, data?: unknown): Promise<T> {
    return this.request<T>(endpoint, {
      method: 'DELETE',
      body: data ? JSON.stringify(data) : undefined,
    })
  }
}

export const api = new ApiClient()
