import assert from 'node:assert/strict'
import test from 'node:test'

import { loadPlugin } from './load-plugin.mjs'

// The roster is the one thing the Control Center cannot get wrong: a bot IS a
// profile, and this page must agree with Bot Mode about who exists, what they
// are called, and who is working — otherwise two surfaces describe the same
// fleet differently and neither can be trusted.

test('registers a page, a sidebar row, and a palette command', () => {
  const { contributions, plugin } = loadPlugin()

  assert.equal(plugin.defaultEnabled, false)
  assert.deepEqual(
    contributions.map(entry => `${entry.area}:${entry.id}`),
    ['routes:page', 'sidebar.nav:nav', 'palette:open']
  )
  assert.equal(contributions[0].data.path, '/control-center')
  assert.equal(contributions[1].data.path, '/control-center')
})

test('listens for turn and reclaim events instead of every gateway frame', () => {
  const { eventSubs, LIVE_EVENT_TYPES, invalidations, disposers } = loadPlugin()

  assert.deepEqual(
    eventSubs.map(entry => entry.type).sort(),
    [...LIVE_EVENT_TYPES].sort()
  )

  eventSubs[0].listener({ type: eventSubs[0].type })
  assert.equal(invalidations.length, 0)

  return new Promise(resolve => {
    setTimeout(() => {
      assert.ok(invalidations.length)
      disposers.forEach(fn => fn())
      assert.equal(eventSubs.length, 0)
      resolve()
    }, 900)
  })
})

test('reads names and Bot Mode identity out of profiles.list', () => {
  const { rosterFromProfiles } = loadPlugin()

  const roster = rosterFromProfiles({
    profiles: [
      {
        name: 'researcher',
        model: 'sonnet',
        ui_meta: { 'hermes-bots': { displayName: 'Research Desk', description: 'Semis coverage' } }
      },
      { name: 'writer' }
    ]
  })

  assert.deepEqual(
    roster.map(row => [row.bot, row.label, row.role]),
    [
      ['researcher', 'Research Desk', 'Semis coverage'],
      ['writer', 'writer', '']
    ]
  )
})

test('reads avatar presence and Bot Mode color from the profile', () => {
  const { rosterFromProfiles } = loadPlugin()

  const roster = rosterFromProfiles({
    profiles: [
      {
        name: 'researcher',
        has_avatar: true,
        ui_meta: { 'hermes-bots': { color: '#112233' } }
      },
      { name: 'writer', has_avatar: 0, ui_meta: { 'hermes-bots': { color: '  ' } } },
      { name: 'default' }
    ]
  })

  assert.deepEqual(
    roster.map(row => [row.bot, row.hasAvatar, row.color]),
    [
      ['default', false, ''],
      ['researcher', true, '#112233'],
      ['writer', false, '']
    ]
  )
})

test('a saved face uses the live color, and the 160px snapshot does not', () => {
  const { liveFace, isBackfilledFacePng } = loadPlugin()

  assert.deepEqual(liveFace('researcher', { shape: 'hexagon', color: 'hsl(240 68% 58%)', custom: true }), {
    kind: 'shape',
    shape: 'hexagon',
    color: 'hsl(240 68% 58%)'
  })
  assert.equal(liveFace('default').color, '#8b5cf6')
  assert.equal(liveFace('accountant').kind, 'shape')
  assert.equal(liveFace('job-scout', { shape: 'blobatar' }).kind, 'blob')

  const png = Buffer.alloc(24)
  png.writeUInt32BE(160, 16)
  png.writeUInt32BE(160, 20)
  const backfill = `data:image/png;base64,${png.toString('base64')}`

  assert.equal(isBackfilledFacePng(backfill), true)
  assert.equal(isBackfilledFacePng('data:image/png;base64,aaaa'), false)
  assert.equal(isBackfilledFacePng('data:image/jpeg;base64,aaaa'), false)
})

test('accepts the older bare-array profiles payload', () => {
  const { rosterFromProfiles } = loadPlugin()

  assert.deepEqual(
    rosterFromProfiles([{ name: 'writer' }]).map(row => row.bot),
    ['writer']
  )
})

test('skips rows without a usable name instead of rendering blanks', () => {
  const { rosterFromProfiles } = loadPlugin()

  assert.deepEqual(rosterFromProfiles({ profiles: [{ name: '  ' }, {}, null] }), [])
})

test('activity comes from the freshest session, including hidden Bot Chats', () => {
  const { activityStamp } = loadPlugin()

  // A canonical Bot Chat is hidden from the session list by design, so keying
  // off last_session alone makes a bot you talk to daily read as stale.
  assert.equal(activityStamp({ canonical_session: { last_active: 500 }, last_session: { last_active: 100 } }), 500)
  assert.equal(activityStamp({ worker_session: { last_active: 900 } }), 900)
  assert.equal(activityStamp({}), 0)
})

test('hidden bots stay reachable but sort last', () => {
  const { visibleRoster } = loadPlugin()

  const rows = visibleRoster(
    [
      { bot: 'archived', label: 'archived', role: '', hidden: true },
      { bot: 'writer', label: 'writer', role: '', hidden: false }
    ],
    ''
  )

  assert.deepEqual(
    rows.map(row => row.bot),
    ['writer', 'archived']
  )
})

test('the filter matches name, label, and role', () => {
  const { visibleRoster } = loadPlugin()

  const roster = [
    { bot: 'researcher', label: 'Research Desk', role: 'semis' },
    { bot: 'writer', label: 'Writer', role: 'drafts' }
  ]

  assert.deepEqual(visibleRoster(roster, 'semis').map(row => row.bot), ['researcher'])
  assert.deepEqual(visibleRoster(roster, 'DESK').map(row => row.bot), ['researcher'])
  assert.deepEqual(visibleRoster(roster, 'nothing'), [])
})
