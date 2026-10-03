import assert from 'node:assert/strict'
import test from 'node:test'

import { loadPlugin } from './load-plugin.mjs'

// Actions are the only place a Home reaches out of its own page, so each one
// must resolve to exactly the operation it names — and a failure must be
// reported rather than swallowed into a button that looks like it worked.

test('run_routine goes through the plugin backend and refreshes the page', async () => {
  const plugin = loadPlugin({
    restResults: { '/home/researcher/run-routine': { ok: true, name: 'Digest', executed: true } }
  })

  await plugin.performAction('researcher', { id: 'r', label: 'Run now', type: 'run_routine', job: 'Digest' })

  assert.deepEqual(plugin.restCalls[0].path, '/home/researcher/run-routine')
  assert.equal(plugin.restCalls[0].opts.method, 'POST')
  assert.deepEqual(plugin.restCalls[0].opts.body, { job: 'Digest' })
  assert.equal(plugin.notifications[0].kind, 'success')
  assert.ok(plugin.invalidations.length)
})

test('a backgrounded run says so instead of claiming it finished', async () => {
  const plugin = loadPlugin({
    restResults: { '/home/bot/run-routine': { ok: true, name: 'Digest', background: true } }
  })

  await plugin.runRoutine('bot', 'Digest')

  assert.match(plugin.notifications[0].message, /background/)
})

test('open_url and open_path use the OS door, not a navigation', async () => {
  const plugin = loadPlugin()

  await plugin.performAction('bot', { id: 'u', label: 'Docs', type: 'open_url', url: 'https://example.com' })
  await plugin.performAction('bot', { id: 'p', label: 'Notes', type: 'open_path', path: '/tmp/notes.md' })

  assert.deepEqual(plugin.opened, ['https://example.com'])
  assert.deepEqual(plugin.revealed, ['/tmp/notes.md'])
  assert.deepEqual(plugin.notifications, [])
})

test('a refused OS call warns instead of failing silently', async () => {
  const plugin = loadPlugin({ openExternal: false, revealPath: false })

  await plugin.performAction('bot', { id: 'u', label: 'Docs', type: 'open_url', url: 'https://example.com' })
  await plugin.performAction('bot', { id: 'p', label: 'Notes', type: 'open_path', path: '/tmp/gone.md' })

  assert.deepEqual(
    plugin.notifications.map(entry => entry.kind),
    ['warning', 'warning']
  )
})

test('open_chat reuses the canonical Bot Chat when one exists', async () => {
  const plugin = loadPlugin({
    requestResults: {
      'profiles.list': {
        profiles: [{ name: 'researcher', canonical_session: { id: 'chat-1' }, last_session: { id: 'chat-2' } }]
      }
    }
  })

  await plugin.performAction('researcher', { id: 'c', label: 'Open chat', type: 'open_chat' })

  assert.deepEqual(plugin.sessionOpens, [{ id: 'chat-1', options: { profile: 'researcher' } }])
  assert.deepEqual(plugin.newChats, [])
})

test('open_chat starts a conversation for a bot that has none', async () => {
  const plugin = loadPlugin({ requestResults: { 'profiles.list': { profiles: [{ name: 'writer' }] } } })

  await plugin.performAction('writer', { id: 'c', label: 'Open chat', type: 'open_chat' })

  assert.deepEqual(plugin.newChats, ['writer'])
  assert.deepEqual(plugin.sessionOpens, [])
})

test('an unknown action type does nothing at all', async () => {
  const plugin = loadPlugin()

  await plugin.performAction('bot', { id: 'x', label: 'Run locally', type: 'exec' })

  assert.deepEqual(plugin.requests, [])
  assert.deepEqual(plugin.restCalls, [])
  assert.deepEqual(plugin.opened, [])
  assert.deepEqual(plugin.revealed, [])
})

test('send_prompt goes to Bot Chat with the declared prompt', async () => {
  const plugin = loadPlugin({ requestResults: { 'cli.exec': { blocked: false, code: 0, output: 'done' } } })

  await plugin.performAction('researcher', {
    id: 'review',
    label: 'Review',
    type: 'send_prompt',
    prompt: 'Review the findings on this dashboard.'
  })

  assert.deepEqual(plugin.requests[0].params.argv.slice(-1), ['Review the findings on this dashboard.'])
})

test('a line click appends item id and title even when the prompt is escalate', () => {
  const { promptForButton } = loadPlugin()

  const sent = promptForButton({ prompt: 'escalate' }, { id: 'api-2-disk', title: 'disk full on api-2' })

  assert.match(sent, /^escalate/)
  assert.match(sent, /\[item id: api-2-disk\]/)
  assert.match(sent, /\[item title: disk full on api-2\]/)
})

test('a line click fills template slots then still appends the item', () => {
  const { promptForButton } = loadPlugin()

  const sent = promptForButton(
    { prompt: 'Escalate {{item.title}} ({{item.id}}).' },
    { id: 'api-2-disk', title: 'disk full on api-2' }
  )

  assert.match(sent, /Escalate disk full on api-2 \(api-2-disk\)\./)
  assert.match(sent, /\[item id: api-2-disk\]/)
})

test('a line send_prompt includes the item title in the query', async () => {
  const plugin = loadPlugin({ requestResults: { 'cli.exec': { blocked: false, code: 0, output: 'done' } } })

  await plugin.performAction(
    'writer',
    { id: 'escalate', label: 'Escalate', type: 'send_prompt', prompt: 'escalate' },
    { id: 'api-2-disk', title: 'disk full on api-2' }
  )

  const query = plugin.requests[0].params.argv.at(-1)

  assert.match(query, /escalate/)
  assert.match(query, /disk full on api-2/)
})

const IGNORE = { id: 'ignore', label: 'Ignore', type: 'run_action', script: 'ignore' }
const ROW = { id: 'api-2-disk', title: 'disk full on api-2', buttons: ['ignore'] }
const RUN_PATH = '/home/monitor/run-action'

function approvalError(script = 'ignore') {
  const body = JSON.stringify({
    detail: { needs_approval: true, script, sha256: 'abc', source: '#!/bin/sh\necho {}', truncated: false }
  })

  return new Error(`Error invoking remote method 'hermes:api': Error: 409: ${body}`)
}

test('run_action POSTs ids only, toasts the result, and refreshes without a chat turn', async () => {
  const plugin = loadPlugin({ restResults: { [RUN_PATH]: { ok: true, hide: true, message: 'Ignored', seq: 3 } } })

  await plugin.performAction('monitor', IGNORE, ROW, { widgetId: 'issues' })

  assert.equal(plugin.restCalls[0].path, RUN_PATH)
  assert.deepEqual(plugin.restCalls[0].opts.body, { button_id: 'ignore', widget_id: 'issues', item_id: 'api-2-disk' })
  assert.deepEqual(plugin.notifications, [{ kind: 'success', message: 'Ignored' }])
  assert.ok(plugin.invalidations.some(entry => entry.kind === 'refetch'))
  assert.deepEqual(plugin.requests, [])
})

test('a toolbar run_action sends no widget or row', async () => {
  const plugin = loadPlugin({ restResults: { [RUN_PATH]: { ok: true } } })

  await plugin.runDeclaredButton('monitor', IGNORE, {})

  assert.deepEqual(plugin.restCalls[0].opts.body, { button_id: 'ignore', widget_id: '', item_id: '' })
})

test('a failed script is reported as an error, not a success', async () => {
  const plugin = loadPlugin({ restResults: { [RUN_PATH]: { ok: false, message: 'ignore exited 1: boom' } } })

  await plugin.performAction('monitor', IGNORE, ROW, { widgetId: 'issues' })

  assert.deepEqual(plugin.notifications, [{ kind: 'error', message: 'ignore exited 1: boom' }])
})

test('a 409 holds the click for review instead of running anything', async () => {
  const plugin = loadPlugin({ restResults: { [RUN_PATH]: approvalError() } })

  await plugin.performAction('monitor', IGNORE, ROW, { widgetId: 'issues' })

  const pending = plugin.$pendingApproval.get()

  assert.equal(pending.script, 'ignore')
  assert.equal(pending.sha256, 'abc')
  assert.equal(pending.bot, 'monitor')
  assert.equal(pending.widgetId, 'issues')
  assert.equal(plugin.notifications[0].kind, 'info')
})

test('approving stores the reviewed hash and retries the click once', async () => {
  const plugin = loadPlugin({
    restResults: {
      [RUN_PATH]: count => (count === 1 ? approvalError() : { ok: true, message: 'Ignored', seq: 1 }),
      '/home/monitor/approve-action': { ok: true }
    }
  })

  await plugin.performAction('monitor', IGNORE, ROW, { widgetId: 'issues' })
  await plugin.approvePendingAction()

  assert.deepEqual(
    plugin.restCalls.map(call => call.path),
    [RUN_PATH, '/home/monitor/approve-action', RUN_PATH]
  )
  assert.deepEqual(plugin.restCalls[1].opts.body, { script: 'ignore', sha256: 'abc' })
  assert.equal(plugin.$pendingApproval.get(), null)
  assert.equal(plugin.notifications.at(-1).message, 'Ignored')
})

test('a refused approval keeps the review open', async () => {
  const plugin = loadPlugin({
    restResults: {
      [RUN_PATH]: approvalError(),
      '/home/monitor/approve-action': new Error('409: {"detail":"home/actions/ignore changed since you reviewed it"}')
    }
  })

  await plugin.performAction('monitor', IGNORE, ROW, { widgetId: 'issues' })
  await plugin.approvePendingAction()

  assert.notEqual(plugin.$pendingApproval.get(), null)
  assert.equal(plugin.notifications.at(-1).kind, 'error')
  assert.equal(plugin.restCalls.length, 2)
})

test('approvalFromError ignores errors that are not approval requests', () => {
  const { approvalFromError } = loadPlugin()

  assert.equal(approvalFromError(new Error('404: {"detail":"no button"}')), null)
  assert.equal(approvalFromError(new Error('409: {"detail":"changed since you reviewed it"}')), null)
  assert.equal(approvalFromError(new Error('boom')), null)
  assert.equal(approvalFromError(approvalError('send-digest')).script, 'send-digest')
})

test('notify: true tells the bot after a successful run; off by default it does not', async () => {
  const quiet = loadPlugin({ restResults: { [RUN_PATH]: { ok: true, seq: 4 } } })

  await quiet.performAction('monitor', IGNORE, ROW, { widgetId: 'issues' })
  assert.deepEqual(quiet.requests, [])

  const loud = loadPlugin({
    restResults: { [RUN_PATH]: { ok: true, seq: 4 } },
    requestResults: { 'cli.exec': { blocked: false, code: 0 } }
  })

  await loud.performAction('monitor', { ...IGNORE, notify: true }, ROW, { widgetId: 'issues' })

  assert.equal(loud.requests[0].method, 'cli.exec')

  const query = loud.requests[0].params.argv.at(-1)

  assert.match(query, /home\/actions\/ignore/)
  assert.match(query, /api-2-disk/)
  assert.match(query, /event 4/)
})

test('notify does not fire when the script failed', async () => {
  const plugin = loadPlugin({ restResults: { [RUN_PATH]: { ok: false, message: 'nope' } } })

  await plugin.performAction('monitor', { ...IGNORE, notify: true }, ROW, { widgetId: 'issues' })

  assert.deepEqual(plugin.requests, [])
})

test('the composer sends to the bot Chat and reports a refusal', async () => {
  const plugin = loadPlugin({ requestResults: { 'cli.exec': { blocked: false, code: 0, output: 'done' } } })

  await plugin.sendPrompt('researcher', 'refresh the numbers')

  const [call] = plugin.requests

  assert.equal(call.method, 'cli.exec')
  assert.deepEqual(call.params.argv, [
    '-p',
    'researcher',
    'chat',
    '-c',
    'Bot Chat',
    '--create-if-missing',
    '-Q',
    '--query',
    'refresh the numbers'
  ])

  const blocked = loadPlugin({ requestResults: { 'cli.exec': { blocked: true, hint: 'not headless' } } })

  await assert.rejects(() => blocked.sendPrompt('bot', 'hi'), /not headless/)

  const failed = loadPlugin({ requestResults: { 'cli.exec': { blocked: false, code: 1, output: 'boom' } } })

  await assert.rejects(() => failed.sendPrompt('bot', 'hi'), /boom/)
})

test('refreshDashboard invalidates the plugin then refetches that bot Home', async () => {
  const plugin = loadPlugin()

  await plugin.refreshDashboard('researcher')

  assert.deepEqual(plugin.invalidations, [
    { kind: 'invalidate', queryKey: ['hermes-bot-hq'] },
    { kind: 'refetch', queryKey: ['hermes-bot-hq', 'home', 'researcher'] }
  ])
})

test('a 30s cli.exec RPC timeout is not treated as unreachable', () => {
  const { isCliExecTimeout } = loadPlugin()

  assert.equal(isCliExecTimeout(new Error('request timed out after 30s: cli.exec')), true)
  assert.equal(isCliExecTimeout(new Error('the gateway refused that command')), false)
  assert.equal(isCliExecTimeout(new Error('boom')), false)
})

test('the unpublished-Home prompt names the skill and the two files', () => {
  const { HOME_BOOTSTRAP_PROMPT } = loadPlugin()

  assert.match(HOME_BOOTSTRAP_PROMPT, /hermes-bot-hq:bot-home/)
  assert.match(HOME_BOOTSTRAP_PROMPT, /home\/schema\.json/)
  assert.match(HOME_BOOTSTRAP_PROMPT, /home\/data\.json/)
})

test('copyText writes the prompt and says so', async () => {
  const written = []
  const previous = globalThis.navigator
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { clipboard: { writeText: text => written.push(text) } }
  })

  try {
    const plugin = loadPlugin()
    const ok = await plugin.copyText(plugin.HOME_BOOTSTRAP_PROMPT)

    assert.equal(ok, true)
    assert.deepEqual(written, [plugin.HOME_BOOTSTRAP_PROMPT])
    assert.equal(plugin.notifications[0].kind, 'success')
  } finally {
    if (previous === undefined) {
      delete globalThis.navigator
    } else {
      Object.defineProperty(globalThis, 'navigator', { configurable: true, value: previous })
    }
  }
})
