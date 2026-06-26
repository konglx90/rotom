import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { useChatContext } from './ChatContext'
import { useSocket } from './SocketContext'
import { issuesApi } from '../api/issues'
import { BreakReminderModal } from '../features/groups/modals/BreakReminderModal'

// 工作会话三件套:页面工作时间统计 + 休息倒计时 + 任务完成声音。
//
// 全局 Provider,挂在 SocketProvider 之内(App.tsx)。即使切到非 GroupChatView
// 路由,计时和声音照常工作;modeSidebar 的 ModeSidebarClock 只是它的一个
// 可视化入口。
//
// 关键约定:
// - 偏好(localStorage 'work_session_*'):
//     sound_enabled       '1' | '0'  默认 '1'
//     sound_volume        '0'–'1'    默认 '0.6'
//     break_interval_min  工作节奏   默认 '45'
//     break_length_min    休息时长   默认 '10'
// - 计时口径:真人页面会话时长,从 Provider 首次挂载开始,刷新即重置。
// - 声音:WebAudio API 现场合成清脆 chime,无外部音频文件依赖。

const DEFAULTS = {
  soundEnabled: true,
  soundVolume: 0.6,
  breakIntervalMin: 45,
  breakLengthMin: 10,
} as const

const POSTPONE_MIN = 5

const LS = {
  soundEnabled: 'work_session_sound_enabled',
  soundVolume: 'work_session_sound_volume',
  breakInterval: 'work_session_break_interval_min',
  breakLength: 'work_session_break_length_min',
} as const

const MINUTE = 60_000

function readBool(key: string, def: boolean): boolean {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return def
    return raw === '1'
  } catch {
    return def
  }
}

function readNumber(key: string, def: number): number {
  try {
    const raw = localStorage.getItem(key)
    if (raw === null) return def
    const n = Number(raw)
    return Number.isFinite(n) ? n : def
  } catch {
    return def
  }
}

function writeBool(key: string, val: boolean) {
  try {
    localStorage.setItem(key, val ? '1' : '0')
  } catch { /* localStorage 不可用时静默 */ }
}

function writeNumber(key: string, val: number) {
  try {
    localStorage.setItem(key, String(val))
  } catch { /* 同上 */ }
}

// 用 WebAudio 现场合成两音符 chime(E5 → B5),无需外部音频文件,
// 避开 HTMLAudioElement 的 autoplay policy 与资源加载失败问题。
function playChime(volume: number) {
  if (typeof window === 'undefined') return
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!AudioCtx) return

  let ctx: AudioContext
  try {
    ctx = new AudioCtx()
  } catch {
    return
  }

  const now = ctx.currentTime
  // 双音:第一个 0–0.18s(E5),第二个 0.14–0.40s(B5),有少量重叠形成清脆 chime。
  const notes: Array<{ freq: number; start: number; dur: number }> = [
    { freq: 659.25, start: 0, dur: 0.18 },
    { freq: 987.77, start: 0.14, dur: 0.28 },
  ]

  const master = ctx.createGain()
  master.gain.value = Math.max(0, Math.min(1, volume))
  master.connect(ctx.destination)

  for (const n of notes) {
    const osc = ctx.createOscillator()
    osc.type = 'sine'
    osc.frequency.value = n.freq
    // 简单 ADSR:快速 attack + 指数 decay,模拟钟琴音色。
    const gain = ctx.createGain()
    gain.gain.setValueAtTime(0, now + n.start)
    gain.gain.linearRampToValueAtTime(0.8, now + n.start + 0.012)
    gain.gain.exponentialRampToValueAtTime(0.001, now + n.start + n.dur)
    osc.connect(gain)
    gain.connect(master)
    osc.start(now + n.start)
    osc.stop(now + n.start + n.dur + 0.05)
  }

  // 自动关闭 ctx 释放音频资源,避免反复 playSound 累积 AudioContext。
  window.setTimeout(() => {
    try { ctx.close() } catch { /* 已被关闭 */ }
  }, 700)
}

const TERMINAL_ISSUE_STATUS = new Set(['completed', 'failed', 'cancelled'])

interface WorkSessionContextValue {
  // 计时
  elapsedMs: number
  // 休息
  nextBreakAt: number
  msUntilBreak: number
  isOnBreak: boolean
  breakEndsAt: number | null
  msUntilBreakEnd: number
  postponeCount: number
  // 偏好
  soundEnabled: boolean
  soundVolume: number
  breakIntervalMin: number
  breakLengthMin: number
  // 操作
  setSoundEnabled: (v: boolean) => void
  setSoundVolume: (v: number) => void
  setBreakIntervalMin: (v: number) => void
  setBreakLengthMin: (v: number) => void
  playSound: () => void
  triggerBreakNow: () => void
  postponeBreak: (minutes?: number) => void
  endBreakEarly: () => void
  resetSession: () => void
}

const WorkSessionContext = createContext<WorkSessionContextValue | null>(null)

export function WorkSessionProvider({ children }: { children: React.ReactNode }) {
  const { lastIssueChange, subscribe } = useSocket()
  const { myAgentName } = useChatContext()

  const [now, setNow] = useState(() => Date.now())

  const [soundEnabled, setSoundEnabledState] = useState(() =>
    readBool(LS.soundEnabled, DEFAULTS.soundEnabled),
  )
  const [soundVolume, setSoundVolumeState] = useState(() =>
    readNumber(LS.soundVolume, DEFAULTS.soundVolume),
  )
  const [breakIntervalMin, setBreakIntervalMinState] = useState(() =>
    readNumber(LS.breakInterval, DEFAULTS.breakIntervalMin),
  )
  const [breakLengthMin, setBreakLengthMinState] = useState(() =>
    readNumber(LS.breakLength, DEFAULTS.breakLengthMin),
  )

  const [nextBreakAt, setNextBreakAt] = useState(
    () => Date.now() + readNumber(LS.breakInterval, DEFAULTS.breakIntervalMin) * MINUTE,
  )
  const [breakInProgress, setBreakInProgress] = useState(false)
  const [breakEndsAt, setBreakEndsAt] = useState<number | null>(null)
  const [postponeCount, setPostponeCount] = useState(0)
  const [reminderOpen, setReminderOpen] = useState(false)

  // 单一 timer(1s)同时推进 elapsedMs 与触发休息到期/休息结束。
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 1000)
    return () => window.clearInterval(id)
  }, [])

  const playSound = useCallback(() => {
    if (!soundEnabled) return
    playChime(soundVolume)
  }, [soundEnabled, soundVolume])

  // 任务完成声音:订阅 lastIssueChange,拉详情比对 status 翻转。
  // 注意 WS 'issue_changed' 的 kind 不带 status,必须 GET 详情再比对。
  const lastStatusRef = useRef<Map<string, string>>(new Map())
  useEffect(() => {
    if (!lastIssueChange) return
    const { issueId } = lastIssueChange
    let cancelled = false
    issuesApi.getById(issueId).then(detail => {
      if (cancelled) return
      const prev = lastStatusRef.current.get(issueId)
      const curr = detail.status
      lastStatusRef.current.set(issueId, curr)
      // 仅在 prev 存在且非终态→终态翻转时响,避免初始化批量加载触发。
      if (prev && !TERMINAL_ISSUE_STATUS.has(prev) && TERMINAL_ISSUE_STATUS.has(curr)) {
        playSound()
      }
    }).catch(() => { /* 网络抖动静默,下次变更再尝试 */ })
    return () => { cancelled = true }
  }, [lastIssueChange, playSound])

  // 群聊消息声音:agent 回复完成(stream_end 或非流式 a2a_message)时响。
  // 过滤掉自己(真人)发的回声。访客模式 myAgentName='' 也会响。
  const myNameRef = useRef(myAgentName)
  useEffect(() => { myNameRef.current = myAgentName }, [myAgentName])
  useEffect(() => {
    return subscribe(msg => {
      if (msg.type !== 'a2a_stream_end' && msg.type !== 'a2a_message') return
      const fromName = msg.from?.name || ''
      if (!fromName || fromName === myNameRef.current) return
      playSound()
    })
  }, [subscribe, playSound])

  // 休息触发:每秒检查 now vs nextBreakAt。到点开 reminder,真正进入休息由
  // 用户在 modal 里点「开始休息」确认;这样允许推迟。
  useEffect(() => {
    if (breakInProgress) return
    if (now >= nextBreakAt) {
      setReminderOpen(true)
      playSound()
    }
  }, [now, nextBreakAt, breakInProgress, playSound])

  // 休息结束触发:breakEndsAt 到点自动关闭并播放返回提示音。
  useEffect(() => {
    if (!breakInProgress || breakEndsAt == null) return
    if (now >= breakEndsAt) {
      setBreakInProgress(false)
      setBreakEndsAt(null)
      setNextBreakAt(Date.now() + breakIntervalMin * MINUTE)
      playSound()
    }
  }, [now, breakInProgress, breakEndsAt, breakIntervalMin, playSound])

  // 偏好变化时同步 localStorage + 推导 nextBreakAt 的 shift
  const setSoundEnabled = useCallback((v: boolean) => {
    setSoundEnabledState(v)
    writeBool(LS.soundEnabled, v)
  }, [])
  const setSoundVolume = useCallback((v: number) => {
    const clamped = Math.max(0, Math.min(1, v))
    setSoundVolumeState(clamped)
    writeNumber(LS.soundVolume, clamped)
  }, [])
  const setBreakIntervalMin = useCallback((v: number) => {
    const clamped = Math.max(1, Math.min(180, Math.round(v)))
    setBreakIntervalMinState(clamped)
    writeNumber(LS.breakInterval, clamped)
  }, [])
  const setBreakLengthMin = useCallback((v: number) => {
    const clamped = Math.max(1, Math.min(60, Math.round(v)))
    setBreakLengthMinState(clamped)
    writeNumber(LS.breakLength, clamped)
  }, [])

  const triggerBreakNow = useCallback(() => {
    setBreakInProgress(true)
    setBreakEndsAt(Date.now() + breakLengthMin * MINUTE)
    setReminderOpen(false)
    setPostponeCount(0)
  }, [breakLengthMin])

  const postponeBreak = useCallback((minutes: number = POSTPONE_MIN) => {
    setReminderOpen(false)
    setPostponeCount(c => c + 1)
    setNextBreakAt(Date.now() + minutes * MINUTE)
  }, [])

  const endBreakEarly = useCallback(() => {
    setBreakInProgress(false)
    setBreakEndsAt(null)
    setNextBreakAt(Date.now() + breakIntervalMin * MINUTE)
    setPostponeCount(0)
  }, [breakIntervalMin])

  const resetSession = useCallback(() => {
    setBreakInProgress(false)
    setBreakEndsAt(null)
    setPostponeCount(0)
    setNextBreakAt(Date.now() + breakIntervalMin * MINUTE)
    elapsedBaseRef.current = Date.now()
  }, [breakIntervalMin])

  // elapsedMs 基准:页面打开时 = Date.now(),resetSession 时被覆盖回当前时间。
  const elapsedBaseRef = useRef<number>(Date.now())

  const elapsedMs = breakInProgress ? 0 : Math.max(0, now - elapsedBaseRef.current)
  const msUntilBreak = breakInProgress
    ? 0
    : Math.max(0, nextBreakAt - now)
  const msUntilBreakEnd = breakInProgress && breakEndsAt != null
    ? Math.max(0, breakEndsAt - now)
    : 0

  const value = useMemo<WorkSessionContextValue>(() => ({
    elapsedMs,
    nextBreakAt,
    msUntilBreak,
    isOnBreak: breakInProgress,
    breakEndsAt,
    msUntilBreakEnd,
    postponeCount,
    soundEnabled,
    soundVolume,
    breakIntervalMin,
    breakLengthMin,
    setSoundEnabled,
    setSoundVolume,
    setBreakIntervalMin,
    setBreakLengthMin,
    playSound,
    triggerBreakNow,
    postponeBreak,
    endBreakEarly,
    resetSession,
  }), [
    elapsedMs,
    nextBreakAt,
    msUntilBreak,
    breakInProgress,
    breakEndsAt,
    msUntilBreakEnd,
    postponeCount,
    soundEnabled,
    soundVolume,
    breakIntervalMin,
    breakLengthMin,
    setSoundEnabled,
    setSoundVolume,
    setBreakIntervalMin,
    setBreakLengthMin,
    playSound,
    triggerBreakNow,
    postponeBreak,
    endBreakEarly,
    resetSession,
  ])

  return (
    <WorkSessionContext.Provider value={value}>
      {children}
      <BreakReminderModal
        open={reminderOpen}
        elapsedMs={elapsedMs}
        breakLengthMin={breakLengthMin}
        postponeCount={postponeCount}
        onStartBreak={triggerBreakNow}
        onPostpone={() => postponeBreak()}
      />
    </WorkSessionContext.Provider>
  )
}

export function useWorkSession(): WorkSessionContextValue {
  const ctx = useContext(WorkSessionContext)
  if (!ctx) throw new Error('useWorkSession must be used inside <WorkSessionProvider>')
  return ctx
}

// 供 ModeSidebarClock 等组件复用的格式化函数。
export function formatHMM(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  return `${h}:${String(m).padStart(2, '0')}`
}

export function formatMMSS(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(totalSec / 60)
  const s = totalSec % 60
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
}
