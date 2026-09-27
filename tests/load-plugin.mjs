/**
 * Test harness for `desktop/plugin.js`.
 *
 * A disk plugin is plain ESM importing `@hermes/plugin-sdk` and the React jsx
 * runtime, neither of which resolves under bare node. So the source is read as
 * text, its imports are stripped, and it is compiled as a function body whose
 * parameters are the stubs — the same idea as the in-tree `hermes-bots` vm
 * harness, but in THIS realm: values built inside a `vm` context carry that
 * context's prototypes, and `deepStrictEqual` rejects them as not
 * reference-equal even when the structure matches. An appended epilogue returns
 * the module-private helpers for assertions.
 */

import { readFileSync } from 'node:fs'

const EXPORTED = [
  'rosterFromProfiles',
  'isBackfilledFacePng',
  'liveFace',
  'activityStamp',
  'visibleRoster',
  'routinesFor',
  'headlineRoutine',
  'botStatus',
  'markdownBlocks',
  'sparklinePath',
  'widgetHasContent',
  'formatNumber',
  'homeSummary',
  'routineSummary',
  'performAction',
  'promptForButton',
  'runDeclaredButton',
  'sendPrompt',
  'refreshDashboard',
  'isCliExecTimeout',
  'runRoutine',
  'LIVE_EVENT_TYPES',
  'subscribeLiveUpdates',
  'toEpochMs',
  'when',
  'HOME_BOOTSTRAP_PROMPT',
  'copyText'
]

export function loadPlugin({ requestResults = {}, restResults = {}, revealPath = true, openExternal = true } = {}) {
  const source = readFileSync(new URL('../desktop/plugin.js', import.meta.url), 'utf8')
    .replace(/^import\s+\{[\s\S]*?\}\s+from '@hermes\/plugin-sdk'\r?\n/m, '')
    .replace(/^import .* from 'react'\r?\n/m, '')
    .replace(/^import .* from 'react\/jsx-runtime'\r?\n/m, '')
    .replace('export default {', 'const plugin = {')
    .concat(`\nreturn { plugin, internals: { ${EXPORTED.join(', ')} } };\n`)

  const requests = []
  const restCalls = []
  const notifications = []
  const invalidations = []
  const opened = []
  const revealed = []
  const sessionOpens = []
  const newChats = []
  const eventSubs = []
  const disposers = []

  const host = {
    state: {},
    request: (method, params) => {
      requests.push({ method, params })

      return Promise.resolve(requestResults[method] ?? {})
    },
    navigate: () => undefined,
    notify: params => notifications.push(params),
    notifyError: (error, fallback) => notifications.push({ kind: 'error', message: fallback, error }),
    openSession: (id, options) => {
      sessionOpens.push({ id, options })

      return Promise.resolve()
    },
    newChat: profile => {
      newChats.push(profile)

      return Promise.resolve()
    },
    onEvent: (type, listener) => {
      eventSubs.push({ type, listener })

      return () => {
        const index = eventSubs.findIndex(entry => entry.listener === listener)

        if (index >= 0) {
          eventSubs.splice(index, 1)
        }
      }
    }
  }

  const context = {
    atom: initial => {
      let value = initial

      return { get: () => value, set: next => (value = next), listen: () => () => undefined }
    },
    cn: (...args) => args.filter(Boolean).join(' '),
    haptic: () => undefined,
    host,
    jsx: (type, props, key) => ({ type, props, key }),
    jsxs: (type, props, key) => ({ type, props, key }),
    profileColor: () => '#abcdef',
    Blobatar: 'Blobatar',
    queryClient: {
      invalidateQueries: params => {
        invalidations.push({ kind: 'invalidate', ...params })
        return Promise.resolve()
      },
      refetchQueries: params => {
        invalidations.push({ kind: 'refetch', ...params })
        return Promise.resolve()
      }
    },
    relativeTime: () => 'just now',
    useQuery: () => ({ data: undefined }),
    useState: initial => [initial, () => undefined],
    useValue: () => undefined,
    PALETTE_AREA: 'palette',
    ROUTES_AREA: 'routes',
    SIDEBAR_NAV_AREA: 'sidebar.nav',
    Badge: 'Badge',
    Button: 'Button',
    EmptyState: 'EmptyState',
    ErrorState: 'ErrorState',
    ScrollArea: 'ScrollArea',
    SearchField: 'SearchField',
    Separator: 'Separator',
    Skeleton: 'Skeleton',
    StatusDot: 'StatusDot',
    Tip: 'Tip'
  }

  const names = Object.keys(context)
  const { plugin, internals } = new Function(...names, source)(...names.map(name => context[name]))

  const contributions = []

  plugin.register({
    register: contribution => contributions.push(contribution),
    registerMany: list => list.forEach(contribution => contributions.push(contribution)),
    storage: { get: (_key, fallback) => fallback, set: () => undefined },
    os: {
      openExternal: url => {
        opened.push(url)

        return Promise.resolve(openExternal)
      },
      revealPath: path => {
        revealed.push(path)

        return Promise.resolve(revealPath)
      }
    },
    rest: (path, opts) => {
      restCalls.push({ path, opts })

      return Promise.resolve(restResults[path] ?? {})
    },
    onDispose: fn => disposers.push(fn)
  })

  return {
    ...internals,
    contributions,
    disposers,
    eventSubs,
    invalidations,
    newChats,
    notifications,
    opened,
    plugin,
    requests,
    restCalls,
    revealed,
    sessionOpens
  }
}
