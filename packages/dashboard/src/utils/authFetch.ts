/**
 * Authenticated fetch wrapper for API requests
 * Automatically adds Authorization header from localStorage
 */

export async function authFetch(
  url: string,
  options: RequestInit = {}
): Promise<Response> {
  // Get token from localStorage
  const token = localStorage.getItem('auth_token');

  // Add Authorization header if token exists
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(options.headers as Record<string, string>),
  };

  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }

  // Make request with auth headers
  // In development, Vite proxy will forward /api/* to http://localhost:19800
  const response = await fetch(url, {
    ...options,
    headers,
  });

  // Handle 401 - token expired or invalid
  if (response.status === 401) {
    // Clear invalid token and redirect to login
    localStorage.removeItem('auth_token');
    window.location.reload();
    throw new Error('Authentication failed');
  }

  return response;
}
