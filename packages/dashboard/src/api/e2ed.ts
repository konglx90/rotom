/**
 * E2ED API client for the dashboard.
 */

import { api } from '../api/client'

export interface E2edRequirement {
  reqId: string
  title?: string
  status: string
  compositeVersion: string
  planVersions: Array<{ version: number; dirName: string; reviewStatus: string | null; createdAt: string }>
  codeVersions: Array<{ version: number; dirName: string; reviewStatus: string | null; createdAt: string }>
  timeline: Array<{ status: string; at: string }>
  runCount: { deliver: number; review: number; reqReview: number; planReview: number; codeReview: number }
  source: string
  links: Array<{ type: string; url: string; branch?: string }>
  workingDir?: string | null
  deliveryAgent?: string
  reviewAgent?: string
}

export interface E2edMetrics {
  totalDuration: number
  planRounds: Array<{ version: number; deliveryDuration: number; reviewDuration: number; result: string }>
  codeRounds: Array<{ version: number; deliveryDuration: number; reviewDuration: number; result: string }>
}

export const e2edApi = {
  list: () => api.get<E2edRequirement[]>('/e2ed/groups'),
  get: (id: string) => api.get<E2edRequirement>(`/e2ed/groups/${id}`),
  text: (id: string) => api.get<{ text: string }>(`/e2ed/groups/${id}/text`),
  artifact: (id: string, path: string) => fetch(`/api/e2ed/groups/${id}/artifacts/${path}`).then(r => r.ok ? r.text() : null),
  create: (opts: { title?: string; text: string; cwd?: string; deliveryAgent?: string; reviewAgent?: string }) =>
    api.post<{ groupId: string; status: string }>('/e2ed/groups', opts),
  metrics: (id: string) => api.get<E2edMetrics>(`/e2ed/groups/${id}/metrics`),
  timeline: (id: string) => api.get<Array<{ eventType: string; agentName: string; content: string; createdAt: string }>>(`/e2ed/groups/${id}/timeline`),
  issues: (id: string) => api.get<Array<{
    id: string; title: string; status: string; type: string | null;
    created_by: string | null; assigned_to: string | null;
    working_dir: string | null; created_at: string;
  }>>(`/e2ed/groups/${id}/issues`),
  deliver: (id: string, opts?: { planOnly?: boolean; codeOnly?: boolean; fix?: boolean }) =>
    api.post(`/e2ed/groups/${id}/deliver`, opts),
  review: (id: string, opts?: { type?: string }) =>
    api.post(`/e2ed/groups/${id}/review`, opts),
  close: (id: string) =>
    api.post(`/e2ed/groups/${id}/close`),
  delete: (id: string) =>
    api.delete(`/e2ed/groups/${id}`),
  guide: () => fetch('/api/e2ed/guide').then(r => r.ok ? r.text() : ''),
}
