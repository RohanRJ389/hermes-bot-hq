/**
 * Bot HQ — the desktop half.
 *
 * A fleet page for every bot on the machine plus, per bot, the dashboard that
 * bot publishes for itself. A bot IS a Hermes profile, so nothing here has to
 * be registered: the roster comes from `profiles.list`, routines from
 * `cron.manage`, and a dashboard appears the moment a bot writes its Home
 * files. The structure of a Home is owned by this plugin (a closed widget
 * vocabulary); the data inside it is owned by the bot.
 */

import {
  Badge,
  Button,
  EmptyState,
  ErrorState,
  PALETTE_AREA,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  ScrollArea,
  SearchField,
  Separator,
  Skeleton,
  StatusDot,
  Tip,
  atom,
  cn,
  haptic,
  host,
  profileColor,
  queryClient,
  relativeTime,
  useQuery,
  useValue
} from '@hermes/plugin-sdk'
import { useState } from 'react'
import { jsx, jsxs } from 'react/jsx-runtime'

const PLUGIN_ID = 'hermes-bot-hq'
const ROUTE = '/control-center'

/** A bot whose newest message landed inside this window reads as active — the
 *  same 90s liveness window Bot Mode's Active-now strip uses, so the two
 *  surfaces never disagree about who is working. */
const ACTIVE_WINDOW_S = 90

/** Paste this in the bot's chat so it publishes a Home. Named so the skill
 *  description matches, and short enough to copy without editing. */
const HOME_BOOTSTRAP_PROMPT =
  'Publish a Home for yourself in Bot HQ. Load the hermes-bot-hq:bot-home skill, then write home/schema.json and home/data.json in your profile. Design the dashboard around the work you actually do, fill it with current numbers, and rewrite data.json at the end of your routines.'

/** SDK `relativeTime` expects epoch **milliseconds**; cron and Home JSON hand us
 *  ISO strings (sometimes epoch seconds). A raw string produces NaN inside
 *  Intl.RelativeTimeFormat and crashes the page — normalize first. */
function toEpochMs(value) {
  if (value == null || value === '') {
    return NaN
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return value < 1e12 ? value * 1000 : value
  }

  const ms = Date.parse(String(value))

  return Number.isFinite(ms) ? ms : NaN
}

function when(value, fallback = '') {
  const ms = toEpochMs(value)

  return Number.isFinite(ms) ? relativeTime(ms) : fallback
}

/** Captured at register() so non-React helpers can reach ctx.rest / storage. */
let pluginCtx = null

/** Which bot the page is showing (null = the fleet grid). Routes are a single
 *  segment with no params, so selection lives here rather than in the URL. */
const $selectedBot = atom(null)

/* ------------------------------------------------------------------ *
 * jsx helper
 * ------------------------------------------------------------------ */

/** `h(type, props, ...children)` over the jsx runtime. A disk plugin is loaded
 *  uncompiled, so JSX syntax cannot be used; this keeps the tree readable
 *  without one. `key` is lifted out of props into the runtime's key argument. */
function h(type, props, ...kids) {
  const { key = undefined, ...rest } = props || {}
  const children = kids.length === 0 ? undefined : kids.length === 1 ? kids[0] : kids
  const finalProps = children === undefined ? rest : { ...rest, children }

  return kids.length > 1 ? jsxs(type, finalProps, key) : jsx(type, finalProps, key)
}

/* ------------------------------------------------------------------ *
 * Roster
 * ------------------------------------------------------------------ */

/** Normalize a `profiles.list` payload into roster rows.
 *
 *  Older gateways answer with a bare array, current ones with
 *  `{ profiles: [...] }`. `ui_meta['hermes-bots']` is Bot Mode's presentation
 *  state; reading it means a bot keeps one identity across both surfaces
 *  instead of this page inventing a second name for the same profile. */
function rosterFromProfiles(payload) {
  const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.profiles) ? payload.profiles : []

  return rows
    .map(row => {
      const bot = String(row?.name || '').trim()

      if (!bot) {
        return null
      }

      const meta = row && typeof row.ui_meta === 'object' && row.ui_meta ? row.ui_meta : {}
      const bots = meta && typeof meta['hermes-bots'] === 'object' && meta['hermes-bots'] ? meta['hermes-bots'] : {}

      return {
        bot,
        label: String(bots.displayName || bots.title || row?.display_name || bot),
        role: String(bots.description || row?.description || ''),
        model: row?.model ? String(row.model) : '',
        hidden: Boolean(bots.hidden),
        lastActive: activityStamp(row)
      }
    })
    .filter(Boolean)
    .sort((a, b) => a.bot.localeCompare(b.bot))
}

/** Freshest activity stamp (epoch seconds) across the sessions `profiles.list`
 *  reports. Canonical Bot Chats are hidden from the session list by design, so
 *  `last_session` alone makes a bot you talk to daily look stale. */
function activityStamp(row) {
  const stamps = [row?.canonical_session?.last_active, row?.last_session?.last_active, row?.worker_session?.last_active]
    .map(value => Number(value) || 0)
    .filter(Boolean)

  return stamps.length ? Math.max(...stamps) : 0
}

/** Rows to render. Bot Mode's "hidden" is a statement about ITS roster, so a
 *  hidden bot stays operable here — it just sorts last and renders dimmed. */
function visibleRoster(roster, query) {
  const needle = String(query || '')
    .trim()
    .toLowerCase()
  const matches = needle
    ? (roster || []).filter(row => `${row.bot} ${row.label} ${row.role}`.toLowerCase().includes(needle))
    : roster || []

  return [...matches].sort((a, b) => Number(a.hidden) - Number(b.hidden))
}

/* ------------------------------------------------------------------ *
 * Routines
 * ------------------------------------------------------------------ */

/** Pull this bot's jobs out of a `cron.manage` response.
 *
 *  The gateway echoes `scoped: <profile>` when it honored the profile scope.
 *  Without that marker (older gateway) fall back to Bot Mode's `[bot:<name>]`
 *  naming rather than attributing another profile's jobs to this bot. */
function routinesFor(bot, payload) {
  const jobs = Array.isArray(payload?.jobs) ? payload.jobs : Array.isArray(payload) ? payload : []
  const scoped = String(payload?.scoped || '') === bot
  const marker = `[bot:${bot}]`

  return jobs
    .filter(job => scoped || String(job?.name || '').includes(marker))
    .map(job => ({
      id: String(job?.job_id || job?.id || ''),
      name:
        String(job?.name || job?.job_id || 'routine')
          .replace(marker, '')
          .trim() || 'routine',
      schedule: String(job?.schedule || ''),
      nextRun: job?.next_run_at || null,
      lastRun: job?.last_run_at || null,
      paused: job?.state === 'paused' || Boolean(job?.paused_at) || job?.enabled === false,
      // `last_status` is null until a job has run once — which is not the same
      // as a failure, so it stays null rather than collapsing into false.
      lastOk: job?.last_status === undefined || job?.last_status === null ? null : job.last_status === 'ok'
    }))
}

/** The one routine a card should show: the next thing that will happen, unless
 *  something already failed — a failure is the more useful headline. */
function headlineRoutine(routines) {
  const list = routines || []
  const failed = list.find(routine => routine.lastOk === false && !routine.paused)

  if (failed) {
    return failed
  }

  const upcoming = list
    .filter(routine => !routine.paused && routine.nextRun)
    .sort((a, b) => String(a.nextRun).localeCompare(String(b.nextRun)))

  return upcoming[0] || list.find(routine => !routine.paused) || list[0] || null
}

/* ------------------------------------------------------------------ *
 * Status
 * ------------------------------------------------------------------ */

/** Fold every signal a card shows into one state.
 *
 *  Never derived from the gateway socket: an open socket says nothing about
 *  whether THIS bot is mid-turn. `busy` is the focused chat's live turn,
 *  `lastActive` covers work that finished moments ago. */
function botStatus({ busy = false, lastActive = 0, routines = [], home = null, now = Date.now() } = {}) {
  if (busy) {
    return { kind: 'busy', tone: 'good', label: 'Working' }
  }

  if (home?.error) {
    return { kind: 'attention', tone: 'bad', label: 'Home unreadable' }
  }

  if ((routines || []).some(routine => routine.lastOk === false && !routine.paused)) {
    return { kind: 'attention', tone: 'bad', label: 'Routine failed' }
  }

  if (lastActive && now / 1000 - lastActive < ACTIVE_WINDOW_S) {
    return { kind: 'active', tone: 'good', label: 'Active' }
  }

  if (home?.stale) {
    return { kind: 'stale', tone: 'warn', label: 'Stale' }
  }

  return { kind: 'idle', tone: 'muted', label: 'Idle' }
}

/* ------------------------------------------------------------------ *
 * Queries
 * ------------------------------------------------------------------ */

function useRoster() {
  return useQuery({
    queryKey: [PLUGIN_ID, 'roster'],
    queryFn: async () => rosterFromProfiles(await host.request('profiles.list', { include_sessions: true })),
    staleTime: 10_000,
    refetchInterval: 30_000
  })
}

function useRoutines(bot) {
  return useQuery({
    queryKey: [PLUGIN_ID, 'routines', bot],
    queryFn: async () =>
      routinesFor(bot, await host.request('cron.manage', { action: 'list', profile: bot, include_disabled: true })),
    enabled: Boolean(bot),
    staleTime: 15_000,
    refetchInterval: 60_000
  })
}

/** One bot's full Home: schema, validated data, and any warnings. */
function useHome(bot) {
  return useQuery({
    queryKey: [PLUGIN_ID, 'home', bot],
    queryFn: () => pluginCtx.rest(`/home/${encodeURIComponent(bot)}`),
    enabled: Boolean(bot),
    retry: false,
    staleTime: 5_000,
    refetchInterval: 30_000
  })
}

/** One row per bot describing its Home, cheap enough to poll for the grid. */
function useHomeIndex() {
  return useQuery({
    queryKey: [PLUGIN_ID, 'home-index'],
    queryFn: async () => {
      const payload = await pluginCtx.rest('/fleet')
      const bots = {}

      for (const row of Array.isArray(payload?.bots) ? payload.bots : []) {
        if (row?.bot) {
          bots[String(row.bot)] = row
        }
      }

      return bots
    },
    // A disabled or not-yet-restarted backend is an expected state, not a
    // crash: the page still lists and operates bots without Home data.
    retry: false,
    staleTime: 10_000,
    refetchInterval: 30_000
  })
}

/* ------------------------------------------------------------------ *
 * Shared chrome
 * ------------------------------------------------------------------ */

function StatusPill({ status }) {
  return h(
    'span',
    { className: 'flex shrink-0 items-center gap-1.5' },
    h(StatusDot, { tone: status.tone }),
    h('span', { className: 'text-[0.6875rem]', style: { color: 'var(--ui-text-tertiary)' } }, status.label)
  )
}

function Meta({ label, value, title }) {
  return h(
    'div',
    { className: 'min-w-0' },
    h('div', { className: 'text-[0.625rem] uppercase tracking-wide', style: { color: 'var(--ui-text-quaternary)' } }, label),
    h('div', { className: 'truncate text-[0.6875rem]', style: { color: 'var(--ui-text-tertiary)' }, title }, value)
  )
}

function routineSummary(routine) {
  if (!routine) {
    return 'none'
  }

  if (routine.paused) {
    return `${routine.name} (paused)`
  }

  if (routine.lastOk === false) {
    return `${routine.name} — failed`
  }

  return routine.nextRun ? `${routine.name} · ${when(routine.nextRun, 'scheduled')}` : routine.name
}

function homeSummary(home) {
  if (!home) {
    return 'none yet'
  }

  if (home.error) {
    return 'unreadable'
  }

  if (!home.has_home) {
    return 'none yet'
  }

  return home.updated_at ? `updated ${when(home.updated_at, 'recently')}` : 'published'
}

/* ------------------------------------------------------------------ *
 * Fleet grid
 * ------------------------------------------------------------------ */

function BotCard({ row, home, busy }) {
  const routines = useRoutines(row.bot).data
  const status = botStatus({ busy, lastActive: row.lastActive, routines, home })
  const next = headlineRoutine(routines)

  return h(
    'button',
    {
      type: 'button',
      onClick: () => {
        haptic('tap')
        selectBot(row.bot)
      },
      className: cn(
        'flex w-full flex-col gap-3 rounded-lg border p-4 text-left transition-colors hover:border-(--ui-accent)',
        row.hidden && 'opacity-60'
      ),
      style: { borderColor: 'var(--ui-stroke-secondary)' }
    },
    h(
      'div',
      { className: 'flex items-start gap-3' },
      h('span', { className: 'mt-1 size-2.5 shrink-0 rounded-full', style: { background: profileColor(row.bot) } }),
      h(
        'div',
        { className: 'min-w-0 flex-1' },
        h(
          'div',
          { className: 'flex items-center gap-2' },
          h('span', { className: 'truncate text-sm font-medium' }, row.label),
          row.hidden ? h(Badge, { size: 'sm', variant: 'secondary' }, 'hidden') : null
        ),
        h(
          'div',
          { className: 'truncate text-xs', style: { color: 'var(--ui-text-tertiary)' } },
          row.role || (row.label === row.bot ? 'no role set' : row.bot)
        )
      ),
      h(StatusPill, { status })
    ),
    h(Separator, {}),
    h(
      'div',
      { className: 'grid grid-cols-2 gap-3' },
      h(Meta, { label: 'Dashboard', value: homeSummary(home), title: home?.error || '' }),
      h(Meta, { label: 'Next routine', value: routineSummary(next), title: next?.schedule || '' })
    )
  )
}

function FleetHeader({ count, busyCount, onRefresh, query, setQuery }) {
  return h(
    'div',
    {
      className: 'flex items-center gap-3 border-b px-6 py-4',
      style: { borderColor: 'var(--ui-stroke-secondary)' }
    },
    h(
      'div',
      { className: 'min-w-0 flex-1' },
      h('div', { className: 'text-sm font-medium' }, 'Bot HQ'),
      h(
        'div',
        { className: 'text-xs', style: { color: 'var(--ui-text-tertiary)' } },
        `${count} ${count === 1 ? 'bot' : 'bots'}${busyCount ? ' · working now' : ''}`
      )
    ),
    h(SearchField, {
      value: query,
      onChange: setQuery,
      placeholder: 'Filter bots',
      containerClassName: 'w-48'
    }),
    h(
      Tip,
      { label: 'Re-read roster, routines, and dashboards' },
      h(Button, { variant: 'ghost', size: 'sm', onClick: onRefresh }, 'Refresh')
    )
  )
}

function BackendHint() {
  return h(
    'div',
    {
      className: 'border-b px-6 py-2 text-[0.6875rem]',
      style: { borderColor: 'var(--ui-stroke-secondary)', color: 'var(--ui-text-tertiary)' }
    },
    'Dashboards unavailable — add hermes-bot-hq to plugins.enabled and restart the backend. Status and routines still work.'
  )
}

function FleetPage() {
  const roster = useRoster()
  const index = useHomeIndex()
  const busy = useValue(host.state.busy)
  const focusedProfile = useValue(host.state.focusedSessionProfile)
  const query = useValue($query)

  if (roster.isLoading) {
    return h(
      'div',
      { className: 'grid gap-3 p-6 sm:grid-cols-2 xl:grid-cols-3' },
      ...[0, 1, 2, 3, 4, 5].map(slot => h(Skeleton, { key: String(slot), className: 'h-32 rounded-lg' }))
    )
  }

  if (roster.isError) {
    return h(
      'div',
      { className: 'p-10' },
      h(
        ErrorState,
        {
          title: 'Could not read the roster',
          description: String(roster.error?.message || roster.error || 'profiles.list failed')
        },
        h('div', { className: 'flex justify-center' }, h(Button, { onClick: () => roster.refetch() }, 'Retry'))
      )
    )
  }

  const rows = visibleRoster(roster.data, query)

  return h(
    'div',
    { className: 'flex h-full flex-col' },
    h(FleetHeader, {
      count: rows.length,
      busyCount: busy ? 1 : 0,
      query,
      setQuery: setQuery,
      onRefresh: () => {
        haptic('tap')
        queryClient.invalidateQueries({ queryKey: [PLUGIN_ID] })
      }
    }),
    index.isError ? h(BackendHint, {}) : null,
    h(
      ScrollArea,
      { className: 'flex-1' },
      rows.length === 0
        ? h('div', { className: 'p-10' }, h(EmptyState, {
            title: query ? 'No bots match' : 'No bots yet',
            description: query
              ? 'Clear the filter to see the whole fleet.'
              : 'Create a bot in Hermes and it appears here automatically — nothing to register.'
          }))
        : h(
            'div',
            { className: 'grid gap-3 p-6 sm:grid-cols-2 xl:grid-cols-3' },
            ...rows.map(row =>
              h(BotCard, {
                key: row.bot,
                row,
                home: index.data?.[row.bot] || null,
                busy: Boolean(busy) && focusedProfile === row.bot
              })
            )
          )
    )
  )
}

/* ------------------------------------------------------------------ *
 * Widgets
 * ------------------------------------------------------------------ */

const TONE_TEXT = {
  good: 'var(--ui-accent)',
  warn: 'var(--ui-text-primary)',
  bad: 'var(--ui-text-primary)',
  neutral: 'var(--ui-text-primary)'
}

const TONE_DOT = { good: 'good', warn: 'warn', bad: 'bad', neutral: 'muted' }
const LEVEL_DOT = { info: 'muted', warn: 'warn', error: 'bad' }

function KpiWidget({ payload }) {
  const items = payload?.items || []

  return h(
    'div',
    { className: 'grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4' },
    ...items.map((item, index) =>
      h(
        'div',
        { key: `${item.label}-${index}`, className: 'min-w-0' },
        h(
          'div',
          { className: 'truncate text-[0.625rem] uppercase tracking-wide', style: { color: 'var(--ui-text-quaternary)' } },
          item.label
        ),
        h(
          'div',
          { className: 'flex items-baseline gap-1.5' },
          h('span', { className: 'text-lg font-medium', style: { color: TONE_TEXT[item.tone] || TONE_TEXT.neutral } }, item.value),
          item.delta ? h('span', { className: 'text-[0.6875rem]', style: { color: 'var(--ui-text-tertiary)' } }, item.delta) : null
        )
      )
    )
  )
}

function TableWidget({ payload }) {
  const columns = payload?.columns || []
  const rows = payload?.rows || []

  return h(
    'div',
    { className: 'overflow-x-auto' },
    h(
      'table',
      { className: 'w-full border-collapse text-xs' },
      columns.length
        ? h(
            'thead',
            {},
            h(
              'tr',
              {},
              ...columns.map((column, index) =>
                h(
                  'th',
                  {
                    key: `${column}-${index}`,
                    className: 'border-b px-2 py-1.5 text-left font-medium',
                    style: { borderColor: 'var(--ui-stroke-secondary)', color: 'var(--ui-text-tertiary)' }
                  },
                  column
                )
              )
            )
          )
        : null,
      h(
        'tbody',
        {},
        ...rows.map((row, rowIndex) =>
          h(
            'tr',
            { key: `row-${rowIndex}` },
            ...row.map((cell, cellIndex) =>
              h(
                'td',
                {
                  key: `cell-${rowIndex}-${cellIndex}`,
                  className: 'border-b px-2 py-1.5 align-top',
                  style: { borderColor: 'color-mix(in srgb, var(--ui-stroke-secondary) 50%, transparent)' }
                },
                cell
              )
            )
          )
        )
      )
    )
  )
}

function ListWidget({ payload, widget, bot, processing, setProcessing, homeUpdatedAt }) {
  const items = payload?.items || []
  const declared = widget?.buttons || []

  return h(
    'div',
    { className: 'flex flex-col gap-2' },
    ...items.map((item, index) =>
      h(
        'div',
        { key: item.id || `${item.title}-${index}`, className: 'flex items-start gap-2' },
        h(StatusDot, { tone: TONE_DOT[item.tone] || 'muted', className: 'mt-1.5' }),
        h(
          'div',
          { className: 'min-w-0 flex-1' },
          item.url
            ? h(
                Button,
                {
                  variant: 'link',
                  size: 'inline',
                  onClick: () => void openExternal(item.url)
                },
                item.title
              )
            : h('div', { className: 'text-xs' }, item.title),
          item.detail
            ? h('div', { className: 'text-[0.6875rem]', style: { color: 'var(--ui-text-tertiary)' } }, item.detail)
            : null
        ),
        h(LineButtons, {
          bot,
          declared,
          item,
          processing,
          setProcessing,
          homeUpdatedAt
        })
      )
    )
  )
}

/** Split plain text into paragraphs and bullet runs.
 *
 *  Markdown here is deliberately shallow: a Home is model-authored, so the
 *  renderer never interprets HTML or inline markup. Paragraphs and bullets are
 *  enough for a summary, and everything renders as escaped text. */
function markdownBlocks(text) {
  const blocks = []

  for (const chunk of String(text || '').split(/\n{2,}/)) {
    const lines = chunk
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)

    if (!lines.length) {
      continue
    }

    const bullets = lines.filter(line => /^[-*]\s+/.test(line))

    if (bullets.length === lines.length) {
      blocks.push({ kind: 'ul', lines: lines.map(line => line.replace(/^[-*]\s+/, '')) })
    } else {
      blocks.push({ kind: 'p', lines })
    }
  }

  return blocks
}

function MarkdownWidget({ payload }) {
  const blocks = markdownBlocks(payload?.text)

  return h(
    'div',
    { className: 'flex flex-col gap-2 text-xs', style: { color: 'var(--ui-text-secondary)' } },
    ...blocks.map((block, index) =>
      block.kind === 'ul'
        ? h(
            'ul',
            { key: `block-${index}`, className: 'ml-4 flex list-disc flex-col gap-1' },
            ...block.lines.map((line, lineIndex) => h('li', { key: `li-${lineIndex}` }, line))
          )
        : h('p', { key: `block-${index}`, className: 'whitespace-pre-wrap' }, block.lines.join('\n'))
    )
  )
}

/** Map points into a 0..100 x 0..100 viewBox path.
 *
 *  An SVG with `preserveAspectRatio: none` scales with its container, which
 *  sidesteps the canvas-in-a-pane trap entirely: no ResizeObserver, no device
 *  pixel ratio, nothing to redraw when the layout tree moves. */
function sparklinePath(points) {
  const usable = (points || []).filter(point => Array.isArray(point) && point.length >= 2)

  if (usable.length < 2) {
    return ''
  }

  const xs = usable.map(point => point[0])
  const ys = usable.map(point => point[1])
  const minX = Math.min(...xs)
  const maxX = Math.max(...xs)
  const minY = Math.min(...ys)
  const maxY = Math.max(...ys)
  const spanX = maxX - minX || 1
  const spanY = maxY - minY || 1

  return usable
    .map((point, index) => {
      const x = ((point[0] - minX) / spanX) * 100
      // SVG y grows downward; invert so a rising series rises on screen.
      const y = 100 - ((point[1] - minY) / spanY) * 100

      return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)} ${y.toFixed(2)}`
    })
    .join(' ')
}

function TimeseriesWidget({ payload }) {
  const series = (payload?.series || []).filter(entry => (entry.points || []).length >= 2)

  if (!series.length) {
    return h('div', { className: 'text-xs', style: { color: 'var(--ui-text-tertiary)' } }, 'not enough points to plot')
  }

  return h(
    'div',
    { className: 'flex flex-col gap-2' },
    ...series.map((entry, index) => {
      const last = entry.points[entry.points.length - 1]

      return h(
        'div',
        { key: `${entry.label}-${index}`, className: 'flex items-center gap-3' },
        h(
          'div',
          { className: 'w-24 shrink-0 truncate text-[0.6875rem]', style: { color: 'var(--ui-text-tertiary)' } },
          entry.label || `series ${index + 1}`
        ),
        h(
          'svg',
          {
            className: 'h-8 flex-1',
            viewBox: '0 0 100 100',
            preserveAspectRatio: 'none',
            role: 'img',
            'aria-label': `${entry.label || 'series'} trend`
          },
          h('path', {
            d: sparklinePath(entry.points),
            fill: 'none',
            stroke: 'var(--ui-accent)',
            strokeWidth: 2,
            vectorEffect: 'non-scaling-stroke'
          })
        ),
        h('div', { className: 'w-14 shrink-0 text-right text-xs' }, formatNumber(last[1]))
      )
    })
  )
}

function formatNumber(value) {
  const number = Number(value)

  if (!Number.isFinite(number)) {
    return ''
  }

  return Math.abs(number) >= 1000 ? number.toLocaleString() : String(Math.round(number * 100) / 100)
}

function SourcesWidget({ payload }) {
  const items = payload?.items || []

  return h(
    'div',
    { className: 'flex flex-col gap-1.5' },
    ...items.map((item, index) =>
      h(
        'div',
        { key: `${item.title}-${index}`, className: 'flex items-baseline justify-between gap-3' },
        item.url
          ? h(Button, { variant: 'link', size: 'inline', onClick: () => void openExternal(item.url) }, item.title)
          : h('span', { className: 'truncate text-xs' }, item.title),
        item.fetched_at
          ? h(
              'span',
              { className: 'shrink-0 text-[0.6875rem]', style: { color: 'var(--ui-text-quaternary)' } },
              when(item.fetched_at)
            )
          : null
      )
    )
  )
}

function AlertsWidget({ payload, widget, bot, processing, setProcessing, homeUpdatedAt }) {
  const items = payload?.items || []
  const declared = widget?.buttons || []

  return h(
    'div',
    { className: 'flex flex-col gap-2' },
    ...items.map((item, index) =>
      h(
        'div',
        { key: item.id || `${item.message}-${index}`, className: 'flex items-start gap-2' },
        h(StatusDot, { tone: LEVEL_DOT[item.level] || 'muted', className: 'mt-1.5' }),
        h(
          'div',
          { className: 'min-w-0 flex-1' },
          h('div', { className: 'text-xs' }, item.message),
          item.detail
            ? h('div', { className: 'text-[0.6875rem]', style: { color: 'var(--ui-text-tertiary)' } }, item.detail)
            : null
        ),
        h(LineButtons, {
          bot,
          declared,
          item,
          processing,
          setProcessing,
          homeUpdatedAt
        })
      )
    )
  )
}

function LineButtons({ bot, declared, item, processing, setProcessing, homeUpdatedAt }) {
  const ids = item?.buttons || []

  if (!ids.length || !declared?.length) {
    return null
  }

  const buttons = ids
    .map(id => declared.find(entry => entry.id === id))
    .filter(Boolean)

  if (!buttons.length) {
    return null
  }

  return h(
    'div',
    { className: 'flex shrink-0 flex-wrap justify-end gap-1' },
    ...buttons.map(action =>
      h(
        Button,
        {
          key: action.id,
          size: 'sm',
          variant: action.primary ? 'default' : 'secondary',
          disabled: processing,
          onClick: () => void runDeclaredButton(bot, action, { item, processing, setProcessing, homeUpdatedAt })
        },
        action.label
      )
    )
  )
}

function ButtonsWidget({ widget, bot, processing, setProcessing, homeUpdatedAt }) {
  const buttons = widget?.buttons || []

  if (!buttons.length) {
    return h('div', { className: 'text-xs', style: { color: 'var(--ui-text-tertiary)' } }, 'no buttons')
  }

  return h(ButtonStrip, { bot, buttons, processing, setProcessing, homeUpdatedAt })
}

const WIDGETS = {
  kpi: KpiWidget,
  table: TableWidget,
  list: ListWidget,
  markdown: MarkdownWidget,
  timeseries: TimeseriesWidget,
  sources: SourcesWidget,
  alerts: AlertsWidget,
  buttons: ButtonsWidget
}

/** True when a widget has something to draw. Keeps an empty payload from
 *  rendering as a confident-looking blank card. */
function widgetHasContent(type, payload, widget) {
  if (type === 'buttons') {
    return Boolean((widget?.buttons || []).length)
  }

  if (!payload) {
    return false
  }

  if (type === 'markdown') {
    return Boolean(String(payload.text || '').trim())
  }

  if (type === 'table') {
    return Boolean((payload.rows || []).length)
  }

  if (type === 'timeseries') {
    return (payload.series || []).some(entry => (entry.points || []).length >= 2)
  }

  return Boolean((payload.items || []).length)
}

function WidgetCard({ widget, payload, bot, processing = false, setProcessing, homeUpdatedAt }) {
  const Component = WIDGETS[widget.type]
  const filled = widget.supported && widgetHasContent(widget.type, payload, widget)
  const body = !widget.supported
    ? h(
        'div',
        { className: 'text-[0.6875rem]', style: { color: 'var(--ui-text-tertiary)' } },
        'This widget type is not in the Home vocabulary, so nothing was rendered.'
      )
    : filled
      ? h(Component, { payload, widget, bot, processing, setProcessing, homeUpdatedAt })
      : h(
          'div',
          { className: 'text-[0.6875rem]', style: { color: 'var(--ui-text-quaternary)' } },
          widget.empty || 'no data yet'
        )

  return h(
    'section',
    {
      className: 'flex flex-col gap-3 rounded-lg border p-4',
      // Inline span: plugin class names are not in Desktop's Tailwind scan, so
      // `sm:col-span-2` never exists in the stylesheet. `sm:grid-cols-2` does
      // (used in-app), which is why half-width cards wrap and full-width ones did not.
      style: {
        borderColor: 'var(--ui-stroke-secondary)',
        ...(widget.width === 'full' ? { gridColumn: '1 / -1' } : {})
      }
    },
    h(
      'div',
      { className: 'flex items-center justify-between gap-2' },
      h('h2', { className: 'text-xs font-medium' }, widget.title || widget.id),
      processing
        ? h(Badge, { size: 'sm', variant: 'secondary' }, 'Updating…')
        : widget.supported
          ? null
          : h(Badge, { size: 'sm', variant: 'secondary' }, `skipped: ${widget.type || 'no type'}`)
    ),
    h('div', { className: processing ? 'opacity-50' : undefined }, body)
  )
}

function WarningsPanel({ warnings }) {
  const [open, setOpen] = useState(false)

  if (!warnings?.length) {
    return null
  }

  return h(
    'div',
    {
      className: 'rounded-lg border px-4 py-3',
      style: { borderColor: 'var(--ui-stroke-secondary)' }
    },
    h(
      'div',
      { className: 'flex items-center gap-2' },
      h(StatusDot, { tone: 'warn' }),
      h(
        'span',
        { className: 'flex-1 text-xs' },
        `${warnings.length} ${warnings.length === 1 ? 'problem' : 'problems'} in this Home`
      ),
      h(Button, { variant: 'text', size: 'micro', onClick: () => setOpen(!open) }, open ? 'Hide' : 'Show')
    ),
    open
      ? h(
          'ul',
          { className: 'mt-2 ml-4 flex list-disc flex-col gap-1 text-[0.6875rem]', style: { color: 'var(--ui-text-tertiary)' } },
          ...warnings.map((warning, index) => h('li', { key: `warning-${index}` }, warning))
        )
      : null
  )
}

/* ------------------------------------------------------------------ *
 * Bot detail
 * ------------------------------------------------------------------ */

function RoutineRow({ routine }) {
  const tone = routine.paused ? 'muted' : routine.lastOk === false ? 'bad' : 'good'

  return h(
    'div',
    {
      className: 'flex items-center gap-3 rounded-md border px-3 py-2',
      style: { borderColor: 'var(--ui-stroke-secondary)' }
    },
    h(StatusDot, { tone }),
    h(
      'div',
      { className: 'min-w-0 flex-1' },
      h('div', { className: 'truncate text-xs' }, routine.name),
      h(
        'div',
        { className: 'truncate text-[0.6875rem]', style: { color: 'var(--ui-text-quaternary)' } },
        routine.schedule || 'no schedule'
      )
    ),
    h(
      'div',
      { className: 'shrink-0 text-[0.6875rem]', style: { color: 'var(--ui-text-tertiary)' } },
      routine.paused ? 'paused' : routine.nextRun ? when(routine.nextRun, 'scheduled') : 'unscheduled'
    )
  )
}

function DetailHeader({ bot, row, status, subtitle, children }) {
  return h(
    'div',
    {
      className: 'flex items-center gap-3 border-b px-6 py-4',
      style: { borderColor: 'var(--ui-stroke-secondary)' }
    },
    h(Button, { variant: 'ghost', size: 'sm', onClick: () => selectBot(null) }, 'Back'),
    h('span', { className: 'size-2.5 shrink-0 rounded-full', style: { background: profileColor(bot) } }),
    h(
      'div',
      { className: 'min-w-0 flex-1' },
      h('div', { className: 'truncate text-sm font-medium' }, row.label),
      h('div', { className: 'truncate text-xs', style: { color: 'var(--ui-text-tertiary)' } }, subtitle || row.role || bot)
    ),
    h(StatusPill, { status }),
    children
  )
}

function MissingHome({ bot, label }) {
  const [copied, setCopied] = useState(false)

  const copy = async () => {
    haptic('tap')
    const ok = await copyText(HOME_BOOTSTRAP_PROMPT)

    if (ok) {
      setCopied(true)
    }

    return ok
  }

  return h(
    'div',
    {
      className: 'flex flex-col gap-3 rounded-lg border px-4 py-4',
      style: { borderColor: 'var(--ui-stroke-secondary)' }
    },
    h('div', { className: 'text-sm font-medium' }, 'No dashboard yet'),
    h(
      'div',
      { className: 'text-xs', style: { color: 'var(--ui-text-tertiary)' } },
      `Paste this into ${label}'s chat and it will publish one.`
    ),
    h(
      'pre',
      {
        className: 'max-h-40 overflow-auto whitespace-pre-wrap rounded-md border px-3 py-2 text-xs leading-5',
        style: { borderColor: 'var(--ui-stroke-secondary)', color: 'var(--ui-text-primary)' }
      },
      HOME_BOOTSTRAP_PROMPT
    ),
    h(
      'div',
      { className: 'flex flex-wrap items-center gap-2' },
      h(Button, { size: 'sm', variant: 'secondary', onClick: () => void copy() }, copied ? 'Copied' : 'Copy'),
      h(
        Button,
        {
          size: 'sm',
          onClick: () => {
            void copy().then(() => void openChat(bot))
          }
        },
        'Copy and open chat'
      )
    )
  )
}

function UpdatedLine({ home }) {
  const data = home?.data
  const parts = []

  if (home?.updated_at) {
    parts.push(`updated ${when(home.updated_at, 'recently')}`)
  }

  if (data?.stale) {
    parts.push('stale')
  }

  if (data?.note) {
    parts.push(data.note)
  }

  if (!parts.length) {
    return null
  }

  return h('div', { className: 'text-[0.6875rem]', style: { color: 'var(--ui-text-tertiary)' } }, parts.join(' · '))
}

/** The page toolbar. Same strip as `schema.actions` (kept so upgrades do not
 *  blank existing Homes) or `schema.toolbar`. Verbs are closed; a send_prompt
 *  button carries declared text, not a shell. */
function Toolbar({ bot, buttons, processing, setProcessing, homeUpdatedAt }) {
  if (!buttons?.length) {
    return null
  }

  return h(ButtonStrip, { bot, buttons, processing, setProcessing, homeUpdatedAt })
}

function ButtonStrip({ bot, buttons, processing, setProcessing, homeUpdatedAt }) {
  const [running, setRunning] = useState('')

  const run = async action => {
    haptic('tap')
    setRunning(action.id)

    try {
      await runDeclaredButton(bot, action, { processing, setProcessing, homeUpdatedAt })
    } finally {
      setRunning('')
    }
  }

  return h(
    'div',
    { className: 'flex flex-wrap items-center gap-2' },
    ...buttons.map(action =>
      h(
        Button,
        {
          key: action.id,
          size: 'sm',
          variant: action.primary ? 'default' : 'secondary',
          disabled: processing || running === action.id,
          onClick: () => void run(action)
        },
        running === action.id ? 'Running…' : action.label
      )
    )
  )
}

/** The opt-in composer: one input, no transcript.
 *
 *  A dashboard that makes you open a chat to act on it has not replaced the
 *  chat. This sends the prompt to the bot's canonical Bot Chat and refreshes
 *  the dashboard when the run returns, so the answer arrives as updated
 *  widgets. Bots that do not need it leave `composer` false and get no input.
 *  `processing` lives on the page so the header and widgets can show the same
 *  in-flight state — the focused chat's busy flag does not cover this run. */
function Composer({ bot, processing, setProcessing, homeUpdatedAt }) {
  const [text, setText] = useState('')

  const send = async () => {
    const prompt = text.trim()

    if (!prompt || processing) {
      return
    }

    await deliverPrompt(bot, prompt, {
      setProcessing,
      homeUpdatedAt,
      onSent: () => setText('')
    })
  }

  return h(
    'div',
    { className: 'flex flex-col gap-1.5' },
    h(
      'div',
      { className: 'flex items-center gap-2 rounded-lg border p-2', style: { borderColor: 'var(--ui-stroke-secondary)' } },
      h('input', {
        value: text,
        disabled: processing,
        placeholder: `Ask ${bot} to update this`,
        onChange: event => setText(event.target.value),
        onKeyDown: event => {
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault()
            void send()
          }
        },
        className: 'min-w-0 flex-1 bg-transparent px-2 text-xs outline-none',
        style: { color: 'var(--ui-text-primary)' }
      }),
      h(
        Button,
        { size: 'sm', disabled: processing || !text.trim(), onClick: () => void send() },
        processing ? 'Working…' : 'Send'
      )
    ),
    processing
      ? h(
          'div',
          { className: 'px-1 text-[0.6875rem]', style: { color: 'var(--ui-text-tertiary)' } },
          'Updating this dashboard…'
        )
      : null
  )
}

function RoutinesSection({ routines }) {
  if (!routines?.length) {
    return null
  }

  return h(
    'div',
    { className: 'flex flex-col gap-2' },
    h('div', { className: 'text-xs font-medium' }, 'Routines'),
    ...routines.map(routine => h(RoutineRow, { key: routine.id || routine.name, routine }))
  )
}

function BotDetail({ bot }) {
  const roster = useRoster()
  const routines = useRoutines(bot)
  const home = useHome(bot)
  const busy = useValue(host.state.busy)
  const focusedProfile = useValue(host.state.focusedSessionProfile)
  const [processing, setProcessing] = useState(false)

  const row = (roster.data || []).find(entry => entry.bot === bot) || { bot, label: bot, role: '', lastActive: 0 }
  const payload = home.data && home.data.has_home ? home.data : null
  const status = botStatus({
    busy: processing || (Boolean(busy) && focusedProfile === bot),
    lastActive: row.lastActive,
    routines: routines.data,
    home: home.data
      ? { error: home.data.error, stale: Boolean(home.data.data?.stale) }
      : home.isError
        ? { error: String(home.error?.message || home.error) }
        : null
  })

  const widgets = payload?.schema?.widgets || []
  const data = payload?.data?.widgets || {}

  return h(
    'div',
    { className: 'flex h-full flex-col' },
    h(
      DetailHeader,
      { bot, row, status, subtitle: payload?.schema?.subtitle },
      h(
        Tip,
        { label: 'Re-read this dashboard' },
        h(
          Button,
          {
            variant: 'ghost',
            size: 'sm',
            onClick: () => {
              haptic('tap')
              void refreshDashboard(bot)
            }
          },
          'Refresh'
        )
      ),
      h(Button, { variant: 'secondary', size: 'sm', onClick: () => void openChat(bot) }, 'Open chat')
    ),
    h(
      ScrollArea,
      { className: 'flex-1' },
      h(
        'div',
        { className: 'flex flex-col gap-5 p-6' },
        payload?.schema?.title
          ? h(
              'div',
              { className: 'flex flex-col gap-1' },
              h('h1', { className: 'text-sm font-medium' }, payload.schema.title),
              h(UpdatedLine, { home: payload })
            )
          : h(UpdatedLine, { home: payload }),
        home.isLoading ? h(Skeleton, { className: 'h-40 rounded-lg' }) : null,
        home.isError
          ? h(
              'div',
              {
                className: 'rounded-lg border px-4 py-3 text-xs',
                style: { borderColor: 'var(--ui-stroke-secondary)', color: 'var(--ui-text-tertiary)' }
              },
              'Could not reach the Home reader. Add hermes-bot-hq to plugins.enabled and restart the backend.'
            )
          : null,
        payload?.error
          ? h(
              'div',
              {
                className: 'rounded-lg border px-4 py-3 text-xs',
                style: { borderColor: 'var(--ui-stroke-secondary)' }
              },
              payload.error
            )
          : null,
        h(Toolbar, {
          bot,
          buttons: payload?.schema?.toolbar || payload?.schema?.actions,
          processing,
          setProcessing,
          homeUpdatedAt: payload?.updated_at
        }),
        payload?.schema?.composer
          ? h(Composer, { bot, processing, setProcessing, homeUpdatedAt: payload?.updated_at })
          : null,
        h(WarningsPanel, { warnings: payload?.warnings }),
        !home.isLoading && !home.isError && !payload ? h(MissingHome, { bot, label: row.label }) : null,
        widgets.length
          ? h(
              'div',
              { className: 'grid gap-4 sm:grid-cols-2' },
              ...widgets.map(widget =>
                h(WidgetCard, {
                  key: widget.id,
                  widget,
                  payload: data[widget.id],
                  bot,
                  processing,
                  setProcessing,
                  homeUpdatedAt: payload?.updated_at
                })
              )
            )
          : null,
        h(RoutinesSection, { routines: routines.data })
      )
    )
  )
}

/* ------------------------------------------------------------------ *
 * Page shell
 * ------------------------------------------------------------------ */

function BotHqPage() {
  const bot = useValue($selectedBot)

  return bot ? h(BotDetail, { bot }) : h(FleetPage, {})
}

/* ------------------------------------------------------------------ *
 * Actions
 * ------------------------------------------------------------------ */

function selectBot(bot) {
  $selectedBot.set(bot)
  pluginCtx?.storage?.set('selectedBot', bot)
}

async function copyText(text) {
  try {
    if (typeof navigator === 'undefined' || !navigator.clipboard?.writeText) {
      throw new Error('clipboard unavailable')
    }

    await navigator.clipboard.writeText(text)
    host.notify({ kind: 'success', message: 'Copied — paste it in chat' })
    return true
  } catch (error) {
    host.notifyError(error, 'Could not copy. Select the prompt and copy it yourself.')
    return false
  }
}

/** Hand a link to the OS. `ctx.os` resolves false rather than throwing when
 *  the capability is missing, so branch on the result instead of assuming. */
async function openExternal(url) {
  const opened = await pluginCtx?.os?.openExternal(url)

  if (!opened) {
    host.notify({ kind: 'warning', message: 'Could not open that link' })
  }
}

/** Execute one declared button. The `type` switch is the whole security model:
 *  a Home describes what it wants, and only these verbs exist. */
async function performAction(bot, action, item) {
  try {
    if (action.type === 'send_prompt') {
      await sendPrompt(bot, promptForButton(action, item))
      return
    }

    if (action.type === 'open_chat') {
      await openChat(bot)
      return
    }

    if (action.type === 'open_url') {
      await openExternal(action.url)
      return
    }

    if (action.type === 'open_path') {
      const revealed = await pluginCtx?.os?.revealPath(action.path)

      if (!revealed) {
        host.notify({ kind: 'warning', message: `Could not reveal ${action.path}` })
      }

      return
    }

    if (action.type === 'run_routine') {
      await runRoutine(bot, action.job)
    }
  } catch (error) {
    host.notifyError(error, `${action.label} failed`)
  }
}

function promptForButton(action, item) {
  let text = String(action?.prompt || '')

  if (!item) {
    return text.trim()
  }

  const id = String(item.id || '')
  const title = String(item.title || item.message || '')

  text = text.replaceAll('{{item.id}}', id).replaceAll('{{item.title}}', title)

  return `${text.trim()}\n\n[item id: ${id}]\n[item title: ${title}]`.trim()
}

async function runDeclaredButton(bot, action, { item, processing, setProcessing, homeUpdatedAt } = {}) {
  if (action.type === 'send_prompt') {
    const prompt = promptForButton(action, item)

    if (!prompt || processing) {
      return
    }

    await deliverPrompt(bot, prompt, { setProcessing, homeUpdatedAt })
    return
  }

  await performAction(bot, action, item)
}

/** Trigger a routine through the plugin's own backend.
 *
 *  Not `cron.manage`: that RPC exposes list/add/remove/pause/resume and has no
 *  run verb, so the backend calls the same code path `hermes cron run` uses. */
async function runRoutine(bot, job) {
  const result = await pluginCtx.rest(`/home/${encodeURIComponent(bot)}/run-routine`, {
    method: 'POST',
    body: { job },
    // A manual run can execute inline and drive a full agent turn.
    timeoutMs: 300_000
  })

  host.notify({
    kind: 'success',
    message: result?.background
      ? `${result.name || job} is running in the background`
      : result?.executed
        ? `${result.name || job} finished`
        : `${result.name || job} will run on the next tick`
  })

  queryClient.invalidateQueries({ queryKey: [PLUGIN_ID] })
}

/** Re-read roster, routines, and this bot's Home. Invalidate is enough for
 *  polling views; awaiting the home refetch keeps the composer "Working"
 *  state up until the new widgets are on screen. */
async function refreshDashboard(bot) {
  await queryClient.invalidateQueries({ queryKey: [PLUGIN_ID] })

  if (bot && typeof queryClient.refetchQueries === 'function') {
    await queryClient.refetchQueries({ queryKey: [PLUGIN_ID, 'home', bot] })
  }
}

/** Desktop's JSON-RPC waiter, not the CLI subprocess. `cli.exec` params.timeout
 *  can be minutes; `host.request` still dies at the default 30s. */
function isCliExecTimeout(error) {
  return /timed out after \d+s:\s*cli\.exec/i.test(String(error?.message || error || ''))
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

/** Keep polling Home after the RPC waiter gave up — the bot is still writing. */
async function awaitHomeCatchup(bot, previousUpdatedAt, { intervalMs = 2_000, maxMs = 120_000 } = {}) {
  const started = Date.now()

  while (Date.now() - started < maxMs) {
    await refreshDashboard(bot)

    const home = typeof queryClient.getQueryData === 'function' ? queryClient.getQueryData([PLUGIN_ID, 'home', bot]) : null

    if (home?.updated_at && home.updated_at !== previousUpdatedAt) {
      return
    }

    await delay(intervalMs)
  }
}

/** Send a prompt, then refresh the Home. Shared by the composer and send_prompt buttons.
 *
 *  Desktop's JSON-RPC door times out at 30s. `timeout: 300` on cli.exec is the
 *  subprocess budget, not that RPC window — a long Home rewrite still finishes,
 *  but the waiter dies. That is not "could not reach". `onSent` runs once the
 *  prompt has been accepted or the waiter has given up, so the composer can
 *  clear its box in both cases and leave it alone when the send failed.
 */
async function deliverPrompt(bot, prompt, { setProcessing, homeUpdatedAt, onSent } = {}) {
  if (typeof setProcessing === 'function') {
    setProcessing(true)
  }

  try {
    await sendPrompt(bot, prompt)

    if (typeof onSent === 'function') {
      onSent()
    }

    await refreshDashboard(bot)
  } catch (error) {
    if (isCliExecTimeout(error)) {
      if (typeof onSent === 'function') {
        onSent()
      }

      host.notify({
        kind: 'info',
        message: 'Still working — this dashboard will update when the bot finishes'
      })
      await awaitHomeCatchup(bot, homeUpdatedAt)
    } else {
      host.notifyError(error, `Could not reach ${bot}`)
    }
  } finally {
    if (typeof setProcessing === 'function') {
      setProcessing(false)
    }
  }
}

/** Send one prompt to a bot's canonical Bot Chat without opening it.
 *
 *  `cli.exec` is the gateway's generic CLI door and the same mechanism bots use
 *  to message each other, so a composer message lands in the bot's real
 *  conversation history rather than in a side channel the bot cannot see. */
async function sendPrompt(bot, prompt) {
  const result = await host.request('cli.exec', {
    argv: ['-p', bot, 'chat', '-c', 'Bot Chat', '--create-if-missing', '-Q', '--query', prompt],
    timeout: 300
  })

  if (result?.blocked) {
    throw new Error(result.hint || 'the gateway refused that command')
  }

  if (Number(result?.code) !== 0) {
    throw new Error(String(result?.output || 'the run failed').slice(0, 400))
  }

  return result
}

/** Open this bot's newest conversation, or start one when it has none.
 *  `openSession` soft-swaps to the owning profile's backend for us. */
async function openChat(bot) {
  try {
    const payload = await host.request('profiles.list', { include_sessions: true })
    const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.profiles) ? payload.profiles : []
    const row = rows.find(entry => String(entry?.name || '') === bot)
    const sessionId = row?.canonical_session?.id || row?.last_session?.id

    if (sessionId) {
      await host.openSession(String(sessionId), { profile: bot })
      return
    }

    await host.newChat(bot)
  } catch (error) {
    host.notifyError(error, `Could not open ${bot}'s chat`)
  }
}

/* ------------------------------------------------------------------ *
 * Search text
 * ------------------------------------------------------------------ */

const $query = atom('')

function setQuery(value) {
  $query.set(String(value || ''))
}

/* ------------------------------------------------------------------ *
 * Live updates
 * ------------------------------------------------------------------ */

/** Gateway events that mean a bot's status or Home just changed.
 *
 *  Turn start/end is the live "working" signal; reclaim is Bot Mode's
 *  "this conversation just came back"; we do not subscribe to `*` because
 *  token deltas would refetch the roster on every streamed character.
 *  Extra end-event aliases are harmless if the gateway never emits them. */
const LIVE_EVENT_TYPES = [
  'turn.started',
  'turn.error',
  'turn.start',
  'turn.ended',
  'turn.end',
  'turn.completed',
  'session.reclaimed'
]

/** Feature-detected: older desktops have no `host.onEvent`. Polling in the
 *  queries still covers that case — this is an accelerator, not the source of
 *  truth. */
function subscribeLiveUpdates(ctx) {
  if (typeof host.onEvent !== 'function') {
    return
  }

  let timer = 0
  const kick = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      queryClient.invalidateQueries({ queryKey: [PLUGIN_ID] })
    }, 750)
  }

  const unsubs = LIVE_EVENT_TYPES.map(type => host.onEvent(type, kick))

  ctx.onDispose?.(() => {
    unsubs.forEach(unsub => unsub?.())
    clearTimeout(timer)
  })
}

/* ------------------------------------------------------------------ *
 * Registration
 * ------------------------------------------------------------------ */

export default {
  id: PLUGIN_ID,
  name: 'Bot HQ',
  description: 'Fleet view of every bot plus per-bot dashboards the bots publish themselves.',
  defaultEnabled: false,
  register(ctx) {
    pluginCtx = ctx

    const restored = ctx.storage?.get('selectedBot', null)

    if (typeof restored === 'string' && restored) {
      $selectedBot.set(restored)
    }

    subscribeLiveUpdates(ctx)

    ctx.registerMany([
      {
        id: 'page',
        area: ROUTES_AREA,
        title: 'Bot HQ',
        data: { path: ROUTE },
        render: () => h(BotHqPage, {})
      },
      {
        id: 'nav',
        area: SIDEBAR_NAV_AREA,
        data: { path: ROUTE, label: 'Bot HQ', codicon: 'dashboard' }
      },
      {
        id: 'open',
        area: PALETTE_AREA,
        data: {
          id: 'control-center.open',
          label: 'Open Bot HQ',
          keywords: ['bots', 'fleet', 'dashboard', 'control', 'hq'],
          run: () => {
            selectBot(null)
            host.navigate(ROUTE)
          }
        }
      }
    ])
  }
}
