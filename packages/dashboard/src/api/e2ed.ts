/**
 * E2ED API client for the dashboard.
 */

import { api } from '../api/client'

export interface E2edRequirement {
  reqId: string
  status: string
  compositeVersion: string
  planVersions: Array<{ version: number; dirName: string; reviewStatus: string | null; createdAt: string }>
  codeVersions: Array<{ version: number; dirName: string; reviewStatus: string | null; createdAt: string }>
  timeline: Array<{ status: string; at: string }>
  runCount: { deliver: number; review: number; reqReview: number; planReview: number; codeReview: number }
}

export interface E2edMetrics {
  totalDuration: number
  planRounds: Array<{ version: number; deliveryDuration: number; reviewDuration: number; result: string }>
  codeRounds: Array<{ version: number; deliveryDuration: number; reviewDuration: number; result: string }>
}

export const e2edApi = {
  list: () => api.get<E2edRequirement[]>('/e2ed/groups'),
  get: (id: string) => api.get<E2edRequirement>(`/e2ed/groups/${id}`),
  create: (opts: { title?: string; text: string; cwd?: string }) =>
    api.post<{ groupId: string; status: string }>('/e2ed/groups', opts),
  metrics: (id: string) => api.get<E2edMetrics>(`/e2ed/groups/${id}/metrics`),
  timeline: (id: string) => api.get<Array<{ eventType: string; agentName: string; content: string; createdAt: string }>>(`/e2ed/groups/${id}/timeline`),
  deliver: (id: string, opts?: { planOnly?: boolean; codeOnly?: boolean; fix?: boolean }) =>
    api.post(`/e2ed/groups/${id}/deliver`, opts),
  review: (id: string, opts?: { type?: string }) =>
    api.post(`/e2ed/groups/${id}/review`, opts),
  close: (id: string) =>
    api.post(`/e2ed/groups/${id}/close`),
}
