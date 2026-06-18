import { api } from './client'
import type { Note, CreateNoteDto } from './types'

export const notesApi = {
  async listByGroup(groupId: string): Promise<Note[]> {
    return api.get<Note[]>(`/groups/${groupId}/notes`)
  },

  async create(groupId: string, data: CreateNoteDto): Promise<{ id: string; title: string }> {
    return api.post<{ id: string; title: string }>(`/groups/${groupId}/notes`, data)
  },

  async getById(id: string): Promise<Note> {
    return api.get<Note>(`/notes/${id}`)
  },

  async update(id: string, data: { title?: string; description?: string }): Promise<{ ok: boolean }> {
    return api.put<{ ok: boolean }>(`/notes/${id}`, data)
  },

  async delete(id: string): Promise<{ ok: boolean }> {
    return api.delete<{ ok: boolean }>(`/notes/${id}`)
  },
}
