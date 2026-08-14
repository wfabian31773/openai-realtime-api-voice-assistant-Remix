/**
 * THE CALL DETAIL PAGE, rebuilt 2026-08-13 in the shape of Vapi's per-call
 * view — the operator's explicit ask: "I want you to get as close if not
 * identical to how the vapi layout is with the frozen recording and all the
 * data points, same styling same layout same everything."
 *
 * One header, one frozen waveform, seven tabs:
 *   Transcripts · Logs · Analysis · Structured Outputs · Messages ·
 *   Call Cost · Latency Summary
 *
 * Every tab is fed by data we actually record (call_turns, call_events,
 * grader_results, tool_timeline, cost columns). Nothing is invented: where
 * Vapi shows a metric our stack cannot honestly measure (their transport
 * hops), the card simply is not there.
 *
 * The waveform is decoded client-side from our own audio proxy
 * (/api/call-logs/:id/audio) — Twilio media needs basic auth, so the proxy is
 * what makes both playback and Web-Audio decoding possible at all. Stereo
 * recordings render as two bands (orange = agent channel, teal = caller);
 * mono renders one teal band rather than faking a second.
 */
import { useQuery } from '@tanstack/react-query'
import { useParams, useNavigate } from 'react-router-dom'
import { useEffect, useMemo, useRef, useState, useCallback } from 'react'
import apiClient from '@/lib/apiClient'
import {
  ArrowLeft, Copy, Link as LinkIcon, Download, Play, Pause, Check,
  MessageSquare, ListOrdered, LineChart, Braces, Code2, CircleDollarSign, Gauge,
  Search, X,
} from 'lucide-react'

// ---------------------------------------------------------------------------
// Types for the consolidated payload
// ---------------------------------------------------------------------------

interface TurnLatency {
  transcriberMs?: number
  endpointingMs?: number
  modelFirstAudioMs?: number
  voiceMs?: number
  callerWaitMs?: number
}

interface TurnRow {
  turn_index: number
  role: 'caller' | 'agent'
  at: string
  raw_transcript: string | null
  final_transcript: string | null
  state: Record<string, unknown> | null
  director_decision: Record<string, unknown> | null
  model_output: { tools?: string[]; latency?: TurnLatency | null } | null
  since_prev_ms: number | null
}

interface EventRow {
  at: string
  level: 'info' | 'warn' | 'error'
  category: string
  message: string
  data: Record<string, unknown> | null
}

interface GraderCheck {
  grader: string
  pass: boolean
  score: number
  reason: string
  severity?: string
  metadata?: Record<string, unknown>
}

interface DetailPayload {
  callLog: Record<string, any>
  turns: TurnRow[]
  events: EventRow[]
  graderResults:
    | { deterministic?: GraderCheck[]; results?: GraderCheck[]; summary?: Record<string, unknown> }
    | GraderCheck[]
    | null
  toolTimeline: { events?: Array<Record<string, any>>; purpose?: string; result?: string } | null
}

// ---------------------------------------------------------------------------
// Small shared bits
// ---------------------------------------------------------------------------

const TABS = [
  { key: 'transcripts', label: 'Transcripts', icon: MessageSquare },
  { key: 'logs', label: 'Logs', icon: ListOrdered },
  { key: 'analysis', label: 'Analysis', icon: LineChart },
  { key: 'structured', label: 'Structured Outputs', icon: Braces },
  { key: 'messages', label: 'Messages', icon: Code2 },
  { key: 'cost', label: 'Call Cost', icon: CircleDollarSign },
  { key: 'latency', label: 'Latency Summary', icon: Gauge },
] as const

type TabKey = (typeof TABS)[number]['key']

const fmtClock = (iso?: string | null) =>
  iso ? new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit' }) : '—'

const fmtDur = (sec?: number | null) => {
  if (sec == null) return '—'
  const m = Math.floor(sec / 60)
  const s = Math.round(sec % 60)
  return m > 0 ? `${m}m ${s}s` : `${s}s`
}

const fmtOffset = (ms: number) => {
  const t = Math.max(0, ms) / 1000
  const m = Math.floor(t / 60)
  const s = (t % 60).toFixed(2).padStart(5, '0')
  return `+${String(m).padStart(2, '0')}:${s}`
}

const fmtMs = (ms?: number | null) => (ms == null ? '—' : `${Math.round(ms)}ms`)

function CopyBtn({ text, className = '' }: { text: string; className?: string }) {
  const [done, setDone] = useState(false)
  return (
    <button
      className={`text-zinc-500 hover:text-zinc-200 transition-colors ${className}`}
      title="Copy"
      onClick={() => {
        void navigator.clipboard.writeText(text)
        setDone(true)
        setTimeout(() => setDone(false), 1200)
      }}
    >
      {done ? <Check className="w-3.5 h-3.5 text-teal-400" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  )
}

const LEVEL_STYLE: Record<string, string> = {
  info: 'bg-sky-500/15 text-sky-300',
  warn: 'bg-amber-500/15 text-amber-300',
  error: 'bg-red-500/15 text-red-300',
  log: 'bg-zinc-600/30 text-zinc-300',
}

const CATEGORY_STYLE: Record<string, string> = {
  session: 'bg-emerald-500/15 text-emerald-300',
  system: 'bg-emerald-500/15 text-emerald-300',
  transcriber: 'bg-purple-500/15 text-purple-300',
  model: 'bg-yellow-500/15 text-yellow-300',
  tool: 'bg-cyan-500/15 text-cyan-300',
  director: 'bg-orange-500/15 text-orange-300',
  vad: 'bg-zinc-600/30 text-zinc-300',
  transcript: 'bg-indigo-500/15 text-indigo-300',
  handoff: 'bg-pink-500/15 text-pink-300',
}

function Chip({ text, styleMap }: { text: string; styleMap: Record<string, string> }) {
  return (
    <span
      className={`inline-block px-2 py-0.5 rounded text-[11px] font-medium capitalize ${styleMap[text.toLowerCase()] ?? 'bg-zinc-600/30 text-zinc-300'}`}
    >
      {text}
    </span>
  )
}

// ---------------------------------------------------------------------------
// The frozen waveform
// ---------------------------------------------------------------------------

interface Peaks {
  /** channel → bucket → peak 0..1 */
  channels: Float32Array[]
  duration: number
}

function useWaveform(audioUrl: string | null) {
  const [peaks, setPeaks] = useState<Peaks | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!audioUrl) return
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch(audioUrl, { credentials: 'include' })
        if (!res.ok) throw new Error(`audio ${res.status}`)
        const buf = await res.arrayBuffer()
        const ctx = new (window.AudioContext || (window as any).webkitAudioContext)()
        const decoded = await ctx.decodeAudioData(buf)
        void ctx.close()
        const BUCKETS = 700
        const channels: Float32Array[] = []
        for (let c = 0; c < Math.min(2, decoded.numberOfChannels); c++) {
          const data = decoded.getChannelData(c)
          const out = new Float32Array(BUCKETS)
          const per = Math.floor(data.length / BUCKETS) || 1
          for (let i = 0; i < BUCKETS; i++) {
            let peak = 0
            const start = i * per
            for (let j = start; j < start + per && j < data.length; j += 8) {
              const v = Math.abs(data[j])
              if (v > peak) peak = v
            }
            out[i] = peak
          }
          channels.push(out)
        }
        if (!cancelled) setPeaks({ channels, duration: decoded.duration })
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : 'decode failed')
      }
    })()
    return () => {
      cancelled = true
    }
  }, [audioUrl])

  return { peaks, error }
}

function WaveformCanvas({
  peaks,
  progress,
  onSeek,
}: {
  peaks: Peaks | null
  progress: number
  onSeek: (frac: number) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const dpr = window.devicePixelRatio || 1
    const w = canvas.clientWidth
    const h = canvas.clientHeight
    canvas.width = w * dpr
    canvas.height = h * dpr
    const g = canvas.getContext('2d')
    if (!g) return
    g.scale(dpr, dpr)
    g.clearRect(0, 0, w, h)

    if (!peaks) {
      g.fillStyle = '#3f3f46'
      g.fillRect(0, h / 2, w, 1)
      return
    }

    const stereo = peaks.channels.length > 1
    // Vapi's split: agent band above the midline in orange, caller below in
    // teal. Channel 1 is the agent leg on Twilio dual-channel recordings.
    const bands = stereo
      ? [
          { data: peaks.channels[1], color: '#f59e0b', base: h * 0.28, span: h * 0.24, up: true },
          { data: peaks.channels[0], color: '#2dd4bf', base: h * 0.62, span: h * 0.34, up: false },
        ]
      : [{ data: peaks.channels[0], color: '#2dd4bf', base: h * 0.5, span: h * 0.42, up: false }]

    const buckets = peaks.channels[0].length
    const bw = w / buckets
    const cut = Math.floor(progress * buckets)

    for (const band of bands) {
      for (let i = 0; i < buckets; i++) {
        const p = band.data[i]
        const bh = Math.max(1, p * band.span)
        g.fillStyle = i <= cut && progress > 0 ? band.color : `${band.color}66`
        if (band.up) g.fillRect(i * bw, band.base - bh, Math.max(0.8, bw * 0.7), bh)
        else g.fillRect(i * bw, band.base - bh / 2, Math.max(0.8, bw * 0.7), bh)
      }
    }

    if (progress > 0) {
      g.strokeStyle = '#e4e4e7'
      g.beginPath()
      g.moveTo(progress * w, 0)
      g.lineTo(progress * w, h)
      g.stroke()
    }
  }, [peaks, progress])

  useEffect(() => {
    draw()
    const onResize = () => draw()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [draw])

  return (
    <canvas
      ref={canvasRef}
      className="w-full h-32 cursor-pointer"
      onClick={(e) => {
        const rect = e.currentTarget.getBoundingClientRect()
        onSeek((e.clientX - rect.left) / rect.width)
      }}
    />
  )
}

function TimeRuler({ duration }: { duration: number }) {
  if (!duration) return null
  const step = duration > 240 ? 30 : 10
  const marks: number[] = []
  for (let t = step; t < duration; t += step) marks.push(t)
  return (
    <div className="relative h-5 text-[10px] text-zinc-500 select-none">
      {marks.map((t) => (
        <span key={t} className="absolute -translate-x-1/2" style={{ left: `${(t / duration) * 100}%` }}>
          | {t >= 60 ? `${Math.floor(t / 60)}:${String(t % 60).padStart(2, '0')}` : t}
        </span>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// The page
// ---------------------------------------------------------------------------

export function CallDetailsPage() {
  const { id } = useParams<{ id: string }>()
  const navigate = useNavigate()
  const [tab, setTab] = useState<TabKey>('transcripts')

  const { data, isLoading } = useQuery<DetailPayload>({
    queryKey: ['call-detail', id],
    queryFn: async () => (await apiClient.get(`/call-logs/${id}/detail`)).data,
    enabled: !!id,
  })

  const log = data?.callLog
  const audioUrl = id ? `/api/call-logs/${id}/audio` : null
  const { peaks, error: waveError } = useWaveform(log ? audioUrl : null)

  // Player
  const audioRef = useRef<HTMLAudioElement>(null)
  const [playing, setPlaying] = useState(false)
  const [rate, setRate] = useState(1)
  const [now, setNow] = useState(0)
  const duration = peaks?.duration ?? log?.duration ?? 0

  useEffect(() => {
    const a = audioRef.current
    if (!a) return
    const onTime = () => setNow(a.currentTime)
    const onEnd = () => setPlaying(false)
    a.addEventListener('timeupdate', onTime)
    a.addEventListener('ended', onEnd)
    return () => {
      a.removeEventListener('timeupdate', onTime)
      a.removeEventListener('ended', onEnd)
    }
  }, [audioUrl])

  const toggle = () => {
    const a = audioRef.current
    if (!a) return
    if (playing) a.pause()
    else void a.play()
    setPlaying(!playing)
  }

  const cycleRate = () => {
    const next = rate === 1 ? 1.5 : rate === 1.5 ? 2 : 1
    setRate(next)
    if (audioRef.current) audioRef.current.playbackRate = next
  }

  const seek = (frac: number) => {
    const a = audioRef.current
    if (!a || !duration) return
    a.currentTime = frac * duration
    setNow(a.currentTime)
  }

  // Derived
  const turns = data?.turns ?? []
  const events = data?.events ?? []
  const checks: GraderCheck[] = useMemo(() => {
    const gr = data?.graderResults as any
    if (!gr) return []
    if (Array.isArray(gr)) return gr
    return gr.deterministic ?? gr.results ?? []
  }, [data])

  const callStart = turns[0]?.at ?? log?.startTime ?? log?.createdAt
  const costCents = log?.totalCostCents ?? (log?.twilioCostCents ?? 0) + (log?.openaiCostCents ?? 0)
  const endedBy =
    log?.whoHungUp === 'caller' ? 'Customer' : log?.whoHungUp === 'agent' ? 'Assistant' : log?.whoHungUp ?? 'Unknown'
  const startedLabel = log?.startTime
    ? `${new Date(log.startTime).toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' })} ${new Date(log.startTime).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false })}`
    : ''

  if (isLoading || !log) {
    return (
      <div className="min-h-screen bg-[#0c0e12] text-zinc-400 flex items-center justify-center">
        {isLoading ? 'Loading call…' : 'Call not found'}
      </div>
    )
  }

  return (
    <div className="min-h-screen bg-[#0c0e12] text-zinc-200">
      <div className="max-w-6xl mx-auto px-6 py-5">
        {/* ---------- Header ---------- */}
        <div className="flex items-start justify-between">
          <div>
            <div className="flex items-center gap-3">
              <button onClick={() => navigate(-1)} className="text-zinc-500 hover:text-zinc-200">
                <ArrowLeft className="w-4 h-4" />
              </button>
              <h1 className="text-lg font-semibold text-zinc-100">
                {startedLabel} {log.direction === 'outbound' ? 'outboundCall' : 'phoneCall'}
              </h1>
            </div>
            <div className="mt-1.5 space-y-1 text-[13px] text-zinc-400">
              <div className="flex items-center gap-2">
                <span className="text-zinc-500">Call ID:</span>
                <span className="font-mono text-zinc-300">
                  {log.callSid ? `${log.callSid.slice(0, 6)}…${log.callSid.slice(-6)}` : log.id}
                </span>
                {log.callSid && <CopyBtn text={log.callSid} />}
                <button
                  className="text-zinc-500 hover:text-zinc-200"
                  title="Copy link"
                  onClick={() => void navigator.clipboard.writeText(window.location.href)}
                >
                  <LinkIcon className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-zinc-500">Assistant Name:</span>
                <span className="text-teal-300">{log.agentUsed ?? 'unknown'}</span>
                <span className="px-1.5 rounded-full border border-teal-500/40 text-teal-300 text-[10px]">v1</span>
                {log.agentId && (
                  <span className="font-mono text-zinc-500">
                    · {String(log.agentId).slice(0, 4)}…{String(log.agentId).slice(-6)}
                  </span>
                )}
              </div>
              <div>
                <span className="text-zinc-500">Ended:</span> <span className="text-zinc-300">{endedBy}</span>
              </div>
            </div>
          </div>
          <div className="text-right space-y-1">
            <div className="flex items-center justify-end gap-2 text-zinc-100">
              <CircleDollarSign className="w-4 h-4 text-zinc-400" />
              <span className="font-semibold">Cost: ${(Math.max(0, costCents) / 100).toFixed(2)}</span>
            </div>
            <div className="text-[13px] text-zinc-400">Duration: {fmtDur(log.duration)}</div>
          </div>
        </div>

        {/* ---------- Recording ---------- */}
        <div className="mt-5">
          <div className="flex items-center justify-between">
            <h2 className="text-base font-semibold text-zinc-100">Recording</h2>
            <span className="font-mono text-sm text-zinc-400">
              {`${String(Math.floor(now / 60)).padStart(2, '0')}:${String(Math.floor(now % 60)).padStart(2, '0')}`}
            </span>
          </div>
          <div className="mt-2 rounded-md border border-zinc-800/80 bg-[#101318] px-3 pt-2">
            <WaveformCanvas peaks={peaks} progress={duration ? now / duration : 0} onSeek={seek} />
            <TimeRuler duration={duration} />
          </div>
          {waveError && <div className="mt-1 text-[11px] text-zinc-500">recording unavailable ({waveError})</div>}
          <div className="mt-2 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <button
                onClick={toggle}
                className="w-9 h-9 rounded-md bg-teal-500 hover:bg-teal-400 text-black flex items-center justify-center"
              >
                {playing ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4 ml-0.5" />}
              </button>
              <button
                onClick={cycleRate}
                className="h-9 px-3 rounded-md border border-zinc-700 text-sm text-zinc-300 hover:bg-zinc-800"
              >
                {rate}x
              </button>
            </div>
            {audioUrl && (
              <a
                href={audioUrl}
                download={`call-${log.callSid ?? id}.mp3`}
                className="h-9 px-3 rounded-md border border-zinc-700 text-sm text-zinc-300 hover:bg-zinc-800 flex items-center gap-2"
              >
                <Download className="w-4 h-4" /> Audio
              </a>
            )}
          </div>
          <audio ref={audioRef} src={audioUrl ?? undefined} preload="metadata" />
        </div>

        {/* ---------- Tabs ---------- */}
        <div className="mt-6 border-b border-zinc-800 flex gap-1 overflow-x-auto">
          {TABS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`flex items-center gap-2 px-4 py-2.5 text-sm whitespace-nowrap border-b-2 -mb-px transition-colors ${
                tab === key ? 'border-teal-400 text-zinc-100' : 'border-transparent text-zinc-500 hover:text-zinc-300'
              }`}
            >
              <Icon className="w-4 h-4" /> {label}
            </button>
          ))}
        </div>

        <div className="py-5">
          {tab === 'transcripts' && <TranscriptsTab turns={turns} log={log} callStart={callStart} />}
          {tab === 'logs' && <LogsTab events={events} toolTimeline={data?.toolTimeline ?? null} />}
          {tab === 'analysis' && (
            <AnalysisTab checks={checks} summary={(data?.graderResults as any)?.summary} log={log} />
          )}
          {tab === 'structured' && <StructuredTab data={data!} />}
          {tab === 'messages' && <MessagesTab turns={turns} />}
          {tab === 'cost' && <CostTab log={log} />}
          {tab === 'latency' && <LatencyTab turns={turns} log={log} />}
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Transcripts
// ---------------------------------------------------------------------------

function TranscriptsTab({
  turns,
  log,
  callStart,
}: {
  turns: TurnRow[]
  log: Record<string, any>
  callStart?: string
}) {
  const agentName = log.agentUsed ?? 'Agent'
  const startMs = callStart ? new Date(callStart).getTime() : null

  // Fall back to the flat transcript column when the turn table has nothing —
  // the honest rendering of an instrumentation gap, and better than a blank tab.
  const fallback: Array<{ role: 'caller' | 'agent'; text: string }> = useMemo(() => {
    if (turns.length > 0 || !log.transcript) return []
    return String(log.transcript)
      .split('\n')
      .filter((l: string) => l.trim())
      .map((l: string) => {
        const caller = /^(caller|patient|user):/i.test(l.trim())
        return { role: caller ? 'caller' : 'agent', text: l.replace(/^\w+:\s*/i, '') } as const
      })
  }, [turns, log.transcript])

  const rows =
    turns.length > 0
      ? turns.map((t) => ({ role: t.role, text: t.final_transcript ?? t.raw_transcript ?? '', at: t.at as string | undefined }))
      : fallback.map((f) => ({ ...f, at: undefined as string | undefined }))

  if (rows.length === 0) return <Empty label="No transcript was captured for this call" />

  return (
    <div className="space-y-4 max-w-3xl">
      {turns.length === 0 && fallback.length > 0 && (
        <div className="text-[11px] text-amber-400/80">
          Rendered from the flat transcript — the per-turn record for this call was lost (instrumentation gap).
        </div>
      )}
      {rows.map((r, i) => (
        <div key={i} className={`flex ${r.role === 'caller' ? 'justify-end' : 'justify-start'}`}>
          <div
            className={`max-w-[78%] rounded-lg px-4 py-2.5 ${
              r.role === 'caller' ? 'bg-[#23262d]' : 'bg-[#171a20] border border-zinc-800/60'
            }`}
          >
            <div className={`text-[11px] mb-1 ${r.role === 'caller' ? 'text-amber-300/80 text-right' : 'text-teal-300/80'}`}>
              {r.role === 'caller' ? 'User' : agentName}
            </div>
            <div className="text-sm text-zinc-200 whitespace-pre-wrap">{r.text}</div>
            {r.at && (
              <div className={`mt-1 text-[10px] text-zinc-500 ${r.role === 'caller' ? 'text-right' : ''}`}>
                {fmtClock(r.at)}
                {startMs ? ` (${fmtOffset(new Date(r.at).getTime() - startMs)})` : ''}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Logs
// ---------------------------------------------------------------------------

function LogsTab({ events, toolTimeline }: { events: EventRow[]; toolTimeline: DetailPayload['toolTimeline'] }) {
  const [q, setQ] = useState('')
  const [level, setLevel] = useState('')
  const [category, setCategory] = useState('')

  // Older calls predate call_events: synthesize rows from the tool timeline so
  // the tab is never a lie about "nothing happened".
  const merged: EventRow[] = useMemo(() => {
    if (events.length > 0) return events
    const evs = toolTimeline?.events ?? []
    return evs.map((e: any) => ({
      at: e.at,
      level: e.outcome?.success === false ? ('warn' as const) : ('info' as const),
      category: 'tool',
      message: `tool: ${e.tool}`,
      data: { ms: e.ms ?? null, outcome: e.outcome ?? null },
    }))
  }, [events, toolTimeline])

  const categories = useMemo(() => [...new Set(merged.map((e) => e.category))].sort(), [merged])
  const filtered = merged.filter(
    (e) =>
      (!level || e.level === level) &&
      (!category || e.category === category) &&
      (!q || `${e.message} ${JSON.stringify(e.data ?? {})}`.toLowerCase().includes(q.toLowerCase())),
  )

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(merged, null, 2)], { type: 'application/json' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = 'call-logs.json'
    a.click()
    URL.revokeObjectURL(a.href)
  }

  return (
    <div>
      <div className="flex items-center gap-3 mb-3">
        <div className="relative flex-1 max-w-md">
          <Search className="w-4 h-4 absolute left-3 top-2.5 text-zinc-500" />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search logs"
            className="w-full h-9 pl-9 pr-8 rounded-md bg-[#14171c] border border-zinc-800 text-sm text-zinc-200 placeholder-zinc-500 focus:outline-none focus:border-teal-500/50"
          />
          {q && (
            <button onClick={() => setQ('')} className="absolute right-2 top-2.5 text-zinc-500 hover:text-zinc-300">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        <select
          value={level}
          onChange={(e) => setLevel(e.target.value)}
          className="h-9 px-3 rounded-md bg-[#14171c] border border-zinc-800 text-sm text-zinc-300"
        >
          <option value="">Level</option>
          <option value="info">Info</option>
          <option value="warn">Warn</option>
          <option value="error">Error</option>
        </select>
        <select
          value={category}
          onChange={(e) => setCategory(e.target.value)}
          className="h-9 px-3 rounded-md bg-[#14171c] border border-zinc-800 text-sm text-zinc-300 capitalize"
        >
          <option value="">Category</option>
          {categories.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <div className="ml-auto flex items-center gap-3">
          <span className="text-sm text-zinc-400">
            <b className="text-zinc-200">{filtered.length}</b> logs
          </span>
          <button
            onClick={exportJson}
            className="h-9 px-3 rounded-md border border-zinc-700 text-sm text-zinc-300 hover:bg-zinc-800 flex items-center gap-2"
          >
            <Download className="w-4 h-4" /> Export
          </button>
        </div>
      </div>

      {filtered.length === 0 ? (
        <Empty label="No events recorded for this call — the event log ships with the 2026-08-13 build, so older calls have only the tool timeline" />
      ) : (
        <div className="rounded-md border border-zinc-800/80 overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-[11px] uppercase tracking-wide text-zinc-500 bg-[#12151a]">
                <th className="px-4 py-2.5 w-44">Time</th>
                <th className="px-4 py-2.5 w-20">Level</th>
                <th className="px-4 py-2.5 w-28">Category</th>
                <th className="px-4 py-2.5">Raw Data</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((e, i) => (
                <tr key={i} className="border-t border-zinc-800/60 align-top">
                  <td className="px-4 py-2 font-mono text-[12px] text-zinc-400">
                    {new Date(e.at).toLocaleTimeString('en-US', { hour12: false })}.
                    {String(new Date(e.at).getMilliseconds()).padStart(3, '0')}
                  </td>
                  <td className="px-4 py-2">
                    <Chip text={e.level} styleMap={LEVEL_STYLE} />
                  </td>
                  <td className="px-4 py-2">
                    <Chip text={e.category} styleMap={CATEGORY_STYLE} />
                  </td>
                  <td className="px-4 py-2">
                    <div className="text-zinc-200">{e.message}</div>
                    {e.data && (
                      <div className="font-mono text-[11px] text-zinc-500 truncate max-w-xl">
                        {JSON.stringify(e.data)}
                      </div>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Analysis (grader results)
// ---------------------------------------------------------------------------

function AnalysisTab({
  checks,
  summary,
  log,
}: {
  checks: GraderCheck[]
  summary?: Record<string, unknown>
  log: Record<string, any>
}) {
  if (checks.length === 0) return <Empty label="This call has not been graded yet" />
  const fails = checks.filter((c) => !c.pass)
  const criticals = fails.filter((c) => c.severity === 'critical')
  const avg = checks.reduce((a, c) => a + (c.score ?? 0), 0) / checks.length

  return (
    <div className="max-w-4xl space-y-4">
      <div className="grid grid-cols-3 gap-3">
        <StatCard label="Checks passed" value={`${checks.length - fails.length}/${checks.length}`} />
        <StatCard label="Average score" value={avg.toFixed(2)} />
        <StatCard label="Critical failures" value={String(criticals.length)} tone={criticals.length ? 'bad' : 'good'} />
      </div>
      {log.agentOutcome && (
        <div className="text-sm text-zinc-400">
          Outcome: <span className="text-zinc-200">{String(log.agentOutcome)}</span>
        </div>
      )}
      <div className="rounded-md border border-zinc-800/80 divide-y divide-zinc-800/60">
        {[...checks]
          .sort((a, b) => Number(a.pass) - Number(b.pass))
          .map((c) => (
            <div key={c.grader} className="px-4 py-3 flex items-start gap-3">
              <span
                className={`mt-0.5 w-2 h-2 rounded-full flex-shrink-0 ${
                  c.pass ? 'bg-emerald-400' : c.severity === 'critical' ? 'bg-red-400' : 'bg-amber-400'
                }`}
              />
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-3">
                  <span className="font-mono text-[13px] text-zinc-200">{c.grader}</span>
                  <span className="text-[11px] text-zinc-500">{(c.score ?? 0).toFixed(2)}</span>
                  {c.severity === 'critical' && !c.pass && (
                    <span className="text-[10px] px-1.5 rounded bg-red-500/15 text-red-300">critical</span>
                  )}
                </div>
                <div className="text-[13px] text-zinc-400 mt-0.5">{c.reason}</div>
              </div>
            </div>
          ))}
      </div>
      {summary && (
        <pre className="text-[11px] text-zinc-500 font-mono bg-[#12151a] rounded-md p-3 overflow-x-auto">
          {JSON.stringify(summary, null, 2)}
        </pre>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Structured Outputs
// ---------------------------------------------------------------------------

function StructuredTab({ data }: { data: DetailPayload }) {
  const log = data.callLog
  const lastAgentTurn = [...data.turns].reverse().find((t) => t.role === 'agent')
  const blocks: Array<{ title: string; value: unknown }> = [
    {
      title: 'Disposition',
      value: {
        outcome: log.agentOutcome ?? null,
        ticketNumber: log.ticketNumber ?? null,
        transferredToHuman: log.transferredToHuman ?? false,
        endedBy: log.whoHungUp ?? null,
      },
    },
    { title: 'Final conversation state', value: lastAgentTurn?.state ?? null },
    { title: 'Tool timeline', value: data.toolTimeline },
  ].filter((b) => b.value != null)

  if (blocks.length === 0) return <Empty label="No structured outputs recorded" />
  return (
    <div className="max-w-4xl space-y-4">
      {blocks.map((b) => (
        <div key={b.title} className="rounded-md border border-zinc-800/80 bg-[#101318]">
          <div className="px-4 py-2 border-b border-zinc-800/60 flex items-center justify-between">
            <span className="text-sm text-zinc-300">{b.title}</span>
            <CopyBtn text={JSON.stringify(b.value, null, 2)} />
          </div>
          <pre className="px-4 py-3 text-[12px] font-mono text-teal-200/80 overflow-x-auto">
            {JSON.stringify(b.value, null, 2)}
          </pre>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Messages (raw turn rows)
// ---------------------------------------------------------------------------

function MessagesTab({ turns }: { turns: TurnRow[] }) {
  if (turns.length === 0) return <Empty label="No per-turn messages recorded for this call" />
  return (
    <div className="max-w-4xl space-y-3">
      {turns.map((t, i) => (
        <div key={i} className="rounded-md border border-zinc-800/80 bg-[#101318]">
          <div className="px-4 py-2 border-b border-zinc-800/60 flex items-center justify-between">
            <div className="flex items-center gap-2 text-[12px]">
              <span className="text-zinc-500">Message {t.turn_index}</span>
              <Chip
                text={t.role === 'caller' ? 'user' : 'bot'}
                styleMap={{ user: 'bg-amber-500/15 text-amber-300', bot: 'bg-teal-500/15 text-teal-300' }}
              />
              <span className="text-zinc-500">{fmtClock(t.at)}</span>
            </div>
            <CopyBtn text={JSON.stringify(t, null, 2)} />
          </div>
          <pre className="px-4 py-3 text-[11px] font-mono text-rose-200/70 overflow-x-auto max-h-56">
            {JSON.stringify(t, null, 2)}
          </pre>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Call Cost
// ---------------------------------------------------------------------------

function CostTab({ log }: { log: Record<string, any> }) {
  const twilio = Math.max(0, log.twilioCostCents ?? 0)
  const openai = Math.max(0, log.openaiCostCents ?? 0)
  const total = Math.max(twilio + openai, log.totalCostCents ?? 0)
  if (!total) return <Empty label="No cost recorded — costs are calculated after the call syncs" />
  const rows = [
    { label: 'Telephony (Twilio)', cents: twilio, color: 'bg-orange-400' },
    { label: 'AI (OpenAI Realtime)', cents: openai, color: 'bg-teal-400' },
  ]
  const perMin = log.duration ? total / 100 / (log.duration / 60) : null
  return (
    <div className="max-w-2xl space-y-4">
      <div className="grid grid-cols-2 gap-3">
        <StatCard label="Total cost" value={`$${(total / 100).toFixed(2)}`} />
        <StatCard label="Per minute" value={perMin != null ? `$${perMin.toFixed(2)}/min` : '—'} />
      </div>
      <div className="h-3 rounded-full overflow-hidden flex bg-zinc-800">
        {rows.map(
          (r) =>
            r.cents > 0 && <div key={r.label} className={r.color} style={{ width: `${(r.cents / total) * 100}%` }} />,
        )}
      </div>
      <div className="rounded-md border border-zinc-800/80 divide-y divide-zinc-800/60">
        {rows.map((r) => (
          <div key={r.label} className="px-4 py-3 flex items-center justify-between text-sm">
            <span className="flex items-center gap-2 text-zinc-300">
              <span className={`w-2 h-2 rounded-full ${r.color}`} /> {r.label}
            </span>
            <span className="font-mono text-zinc-200">${(r.cents / 100).toFixed(2)}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Latency Summary
// ---------------------------------------------------------------------------

const LAT_PARTS = [
  { key: 'transcriberMs', label: 'Transcriber', color: '#c084fc', dot: 'bg-purple-400' },
  { key: 'endpointingMs', label: 'Endpointing', color: '#34d399', dot: 'bg-emerald-400' },
  { key: 'modelFirstAudioMs', label: 'LLM', color: '#facc15', dot: 'bg-yellow-400' },
  { key: 'voiceMs', label: 'Voice', color: '#60a5fa', dot: 'bg-blue-400' },
] as const

function LatencyTab({ turns, log }: { turns: TurnRow[]; log: Record<string, any> }) {
  const agentTurns = turns.filter((t) => t.role === 'agent' && t.model_output?.latency)
  const avg = (key: keyof TurnLatency) => {
    const vals = agentTurns.map((t) => t.model_output!.latency![key]).filter((v): v is number => v != null)
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null
  }
  const avgWait = avg('callerWaitMs')
  const parts = LAT_PARTS.map((p) => ({ ...p, ms: avg(p.key as keyof TurnLatency) }))
  const partsTotal = parts.reduce((a, p) => a + (p.ms ?? 0), 0)

  return (
    <div className="max-w-4xl space-y-5">
      <div className="grid grid-cols-2 gap-3">
        <StatCard label="Turns" value={String(log.totalTurns ?? turns.length)} big />
        <StatCard label="Avg Caller Wait" value={avgWait != null ? `${Math.round(avgWait)}ms` : '—'} big />
      </div>

      {agentTurns.length === 0 ? (
        <Empty label="Per-turn latency ships with the 2026-08-13 build — calls before it have only end-to-end timings" />
      ) : (
        <>
          <div>
            <div className="text-sm text-zinc-300 mb-2">Latency Breakdown</div>
            <div className="h-3 rounded-full overflow-hidden flex bg-zinc-800">
              {parts.map(
                (p) =>
                  (p.ms ?? 0) > 0 && (
                    <div key={p.key} style={{ width: `${((p.ms ?? 0) / partsTotal) * 100}%`, background: p.color }} />
                  ),
              )}
            </div>
          </div>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            {parts.map((p) => (
              <div key={p.key} className="rounded-md border border-zinc-800/80 bg-[#101318] px-4 py-3">
                <div className="flex items-center gap-2 text-sm text-zinc-300">
                  <span className={`w-2 h-2 rounded-full ${p.dot}`} /> {p.label}
                  <span className="ml-auto font-mono text-zinc-100">{fmtMs(p.ms)}</span>
                </div>
                <div className="text-[10px] text-zinc-500 mt-1">Avg Latency</div>
              </div>
            ))}
          </div>

          <div>
            <div className="text-sm text-zinc-300 mb-1">Latency Per Turn</div>
            <div className="text-[11px] text-zinc-500 mb-2">Individual turn breakdown (all values in milliseconds)</div>
            <div className="rounded-md border border-zinc-800/80 divide-y divide-zinc-800/60">
              {agentTurns.map((t) => {
                const l = t.model_output!.latency!
                const total = LAT_PARTS.reduce((a, p) => a + (l[p.key as keyof TurnLatency] ?? 0), 0)
                return (
                  <div key={t.turn_index} className="px-4 py-2.5">
                    <div className="flex items-center justify-between text-[12px] text-zinc-400">
                      <span>Turn {t.turn_index}</span>
                      <span className="font-mono">
                        {l.callerWaitMs != null ? `${Math.round(l.callerWaitMs)}ms wait` : fmtMs(total)}
                      </span>
                    </div>
                    <div className="mt-1.5 h-2 rounded-full overflow-hidden flex bg-zinc-800">
                      {LAT_PARTS.map((p) => {
                        const v = l[p.key as keyof TurnLatency] ?? 0
                        return v > 0 && total > 0 ? (
                          <div key={p.key} style={{ width: `${(v / total) * 100}%`, background: p.color }} />
                        ) : null
                      })}
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </>
      )}

      {log.firstTranscriptDelayMs != null && (
        <div className="text-[12px] text-zinc-500">
          First transcript delay:{' '}
          <span className="font-mono text-zinc-300">{fmtMs(log.firstTranscriptDelayMs)}</span>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------

function StatCard({ label, value, big, tone }: { label: string; value: string; big?: boolean; tone?: 'good' | 'bad' }) {
  return (
    <div className="rounded-md border border-zinc-800/80 bg-[#101318] px-5 py-4">
      <div className="text-[12px] text-zinc-500">{label}</div>
      <div
        className={`${big ? 'text-3xl' : 'text-xl'} font-semibold mt-1 ${
          tone === 'bad' ? 'text-red-400' : tone === 'good' ? 'text-emerald-400' : 'text-zinc-100'
        }`}
      >
        {value}
      </div>
    </div>
  )
}

function Empty({ label }: { label: string }) {
  return (
    <div className="rounded-md border border-dashed border-zinc-800 px-6 py-10 text-center text-sm text-zinc-500">
      {label}
    </div>
  )
}
