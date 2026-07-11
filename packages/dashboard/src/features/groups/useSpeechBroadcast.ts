import { useCallback, useEffect, useRef, useState } from 'react'
import { useSocket } from '../../context/SocketContext'
import type { ServerMessage } from './types'

/**
 * 群聊语音播报:像豆包那样把 agent 的回复读出来。
 *
 * 设计要点(见接入时的需求约定):
 *  - **等消息返回完整再播**:逐 token 的 `a2a_stream_chunk` 只累积不播,
 *    在 `a2a_stream_end` 流结束时把完整正文一次性读出;`a2a_message`
 *    一次性到达的完整消息直接读。不逐字念、不念半截。
 *  - **只念"实实在在的文字"**:播报前用 STRUCT_BLOCK_RE 剔除
 *    `[thinking]`/`[tool:exec]`/`[tool-result]` 等推导与工具过程块,
 *    再去掉 markdown 符号,只读纯正文。剔除后为空的纯工具消息不念。
 *  - **只念当前对话**:订阅时按 conversation.groupId 过滤,切走的群不吵。
 *  - **不念自己 / 系统**:from === myAgentName 或 'system' 跳过。
 *  - **不重复 / 不念历史**:历史消息走 REST 拉取,不触发 WS 事件,
 *    所以天然不会一进群把历史全读一遍。
 *
 * 开关默认关:浏览器语音需要用户手势解锁,用户点开开关即解锁。
 */

const STORAGE_KEY = 'rotom-speech-broadcast'
/** 单条播报正文上限,超长截断,避免一条长回复念很久。 */
const MAX_LEN = 800

// 结构化块标记(thinking / tool:exec / tool-result 等)—— 与 MessageRow.tsx:23
// 的 STRUCT_BLOCK_RE 同源,源头是 MarkdownContent 的 TAGS 列表。新增标签时两处一起改。
const STRUCT_BLOCK_RE =
  /\[(?:thinking|status:thinking|tool:exec|tool-result:exec|tool:patch|tool:ask|tool-result:ask)\][\s\S]*?(?:\[\/(?:thinking|status:thinking|tool:exec|tool-result:exec|tool:patch|tool:ask|tool-result:ask)\]|$)/g

/**
 * 把一条消息的原始 content 清洗成适合朗读的纯文本:
 * 剔除推导/工具结构块、代码块、图片、表格、标题/列表/强调等 markdown 符号,
 * 保留链接文字。剔除后为空字符串的视为「无可念正文」。
 */
export function toSpeakableText(content: string): string {
  const s = content
    .replace(STRUCT_BLOCK_RE, ' ') // 推导 / 工具过程块
    .replace(/```[\s\S]*?```/g, ' 代码块 ') // 围栏代码块
    .replace(/`([^`\n]+)`/g, '$1') // 行内代码
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ') // 图片
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1') // 链接:保留文字,丢 URL
    .replace(/^\s{0,3}#{1,6}\s+/gm, '') // 标题井号
    .replace(/^\s{0,3}>\s?/gm, '') // 引用
    .replace(/^\s*[-*+]\s+/gm, '') // 无序列表符
    .replace(/^\s*\d+[.)]\s+/gm, '') // 有序列表序号
    .replace(/^\s*\|.*\|\s*$/gm, ' ') // 表格整行
    .replace(/\*\*([^*]+)\*\*/g, '$1') // 粗体
    .replace(/__([^_]+)__/g, '$1')
    .replace(/[*_~]/g, '') // 残留强调 / 删除线符号
    .replace(/\|/g, ' ') // 残留表格竖线
    .replace(/\n{3,}/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim()
  return s
}

function pickZhVoice(voices: SpeechSynthesisVoice[]): SpeechSynthesisVoice | null {
  return (
    voices.find((v) => /zh(-|_)?CN/i.test(v.lang)) ||
    voices.find((v) => /^zh/i.test(v.lang)) ||
    null
  )
}

interface UseSpeechBroadcastParams {
  myAgentName: string
  selectedGroupId: string
}

export function useSpeechBroadcast({ myAgentName, selectedGroupId }: UseSpeechBroadcastParams) {
  const { subscribe } = useSocket()

  const [enabled, setEnabled] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === '1'
    } catch {
      return false
    }
  })

  // 用 ref 在 socket 订阅回调里读最新值,避免回调重新订阅造成漏消息。
  const enabledRef = useRef(enabled)
  useEffect(() => {
    enabledRef.current = enabled
  }, [enabled])

  const myAgentNameRef = useRef(myAgentName)
  const selectedGroupIdRef = useRef(selectedGroupId)
  useEffect(() => {
    myAgentNameRef.current = myAgentName
    selectedGroupIdRef.current = selectedGroupId
  })

  // 中文语音引擎(Chrome 异步加载,监听 voiceschanged)。
  const zhVoiceRef = useRef<SpeechSynthesisVoice | null>(null)
  useEffect(() => {
    if (typeof window === 'undefined' || !('speechSynthesis' in window)) return
    const synth = window.speechSynthesis
    const load = () => {
      zhVoiceRef.current = pickZhVoice(synth.getVoices())
    }
    load()
    synth.onvoiceschanged = load
    return () => {
      synth.onvoiceschanged = null
    }
  }, [])

  // 累积每个 requestId 的流式 delta;stream_end 时一次性念出完整正文。
  const streamAccumRef = useRef<Map<string, string>>(new Map())

  // 已念过的 requestId 集合:同一条回复 master 可能既推 a2a_stream_end 又推
  // a2a_message(见 useGroupChatWebSocket 里 `id === requestId || id === stream_<rid>`
  // 的去重),用 requestId 去重,只念第一遍,避免「说两遍」。
  const spokenReqRef = useRef<Set<string>>(new Set())

  const speak = useCallback((from: string, content: string) => {
    if (from === myAgentNameRef.current) return // 不念自己
    if (!from || from === 'system') return // 不念系统消息(多为工具/状态日志)
    const text = toSpeakableText(content)
    if (!text) return // 剔除后无正文(纯推导/工具消息)

    const synth = typeof window !== 'undefined' ? window.speechSynthesis : undefined
    if (!synth) return

    const body = text.length > MAX_LEN ? `${text.slice(0, MAX_LEN)}。后续内容较长，已省略。` : text
    // 「X 说，正文」:群里有多个 agent,带上说话人更易区分。
    const utter = new SpeechSynthesisUtterance(`${from} 说，${body}`)
    utter.lang = 'zh-CN'
    utter.rate = 1
    utter.pitch = 1
    if (zhVoiceRef.current) utter.voice = zhVoiceRef.current
    synth.speak(utter) // 引擎自带队列,多条顺序念
  }, [])

  // 标记某 requestId 已念过。返回 true=首次(应念),false=重复(跳过)。
  // 集合上限 200,超了只保留最近 100,防长会话无限增长。
  const markSpoken = useCallback((rid: string): boolean => {
    if (!rid) return true // 没带 requestId 无法去重,允许念
    if (spokenReqRef.current.has(rid)) return false
    spokenReqRef.current.add(rid)
    if (spokenReqRef.current.size > 200) {
      const recent = Array.from(spokenReqRef.current).slice(-100)
      spokenReqRef.current = new Set(recent)
    }
    return true
  }, [])

  useEffect(() => {
    return subscribe((msg: ServerMessage) => {
      if (!enabledRef.current) return
      const gid = selectedGroupIdRef.current
      const msgGid = msg.conversation?.groupId
      if (!gid || gid !== msgGid) return // 只念当前对话

      if (msg.type === 'a2a_message') {
        const content = msg.payload?.message || ''
        if (!content) return
        if (!markSpoken(msg.requestId || '')) return // 已由 stream_end 念过
        speak(msg.from?.name || '', content)
        return
      }

      if (msg.type === 'a2a_stream_chunk') {
        const rid = msg.requestId || ''
        if (!rid) return
        const delta = msg.delta || ''
        const prev = streamAccumRef.current.get(rid) || ''
        streamAccumRef.current.set(rid, prev + delta)
        return
      }

      if (msg.type === 'a2a_stream_end') {
        const rid = msg.requestId || ''
        const content = streamAccumRef.current.get(rid) || ''
        streamAccumRef.current.delete(rid)
        if (msg.cancelled) return // 用户主动中断的半截消息不念
        if (!markSpoken(rid)) return // 已由 a2a_message 念过
        if (content) speak(msg.from?.name || '', content)
        return
      }
    })
  }, [subscribe, speak, markSpoken])

  const toggle = useCallback(() => {
    setEnabled((prev) => {
      const next = !prev
      try {
        localStorage.setItem(STORAGE_KEY, next ? '1' : '0')
      } catch {
        /* ignore */
      }
      // 关闭时立刻停掉正在念的,避免关了开关还在念完一长串。
      if (!next && typeof window !== 'undefined' && 'speechSynthesis' in window) {
        window.speechSynthesis.cancel()
      }
      return next
    })
  }, [])

  return { enabled, toggle }
}
