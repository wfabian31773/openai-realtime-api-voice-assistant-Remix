import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  OPERATOR_FALLBACK_PATH,
  OPERATOR_INBOUND_PATH,
  OPERATOR_SMS_PATH,
  OPERATOR_INBOUND_URL,
  RUNTIME_URL_SHAPE,
  WHERE_TO_REPOINT,
  isWorkspaceHost,
  notLiveReady,
  runtimePathFor,
  servableLanes,
} from './twilioEndpointReference'

const slugs = (h: Parameters<typeof servableLanes>[0]) => servableLanes(h)?.map((l) => l.slug) ?? null

describe('the endpoint reference says only what the running code serves', () => {
  it('names the runtime URL shape with a placeholder host', () => {
    expect(RUNTIME_URL_SHAPE).toBe('https://<published host>/voice/<lane>')
    expect(runtimePathFor('records')).toBe('/voice/records')
  })

  it('names the operator line exactly as server/index.ts lets it past the proxy', () => {
    const index = readFileSync(join(__dirname, '../../../server/index.ts'), 'utf8')
    expect(index).toContain(`'${OPERATOR_INBOUND_PATH}'`)
    // It is not the only /api/voice path the runtime answers (Codex on #535):
    // the operator line's own callback paths pass too.
    expect(index).toContain(`'${OPERATOR_INBOUND_PATH}/status'`)
    // The card names the fallback and messaging paths, so they must be on the list.
    expect(index).toContain(`'${OPERATOR_FALLBACK_PATH}'`)
    expect(index).toContain(`'${OPERATOR_SMS_PATH}'`)
    // And every /api/voice path the runtime answers is the operator line's own
    // (the card says so).
    const list = index.slice(index.indexOf("app.use('/api/voice'"), index.indexOf('].includes(req.originalUrl'))
    const listed = [...list.matchAll(/'(\/api\/voice\/[^']*)'/g)].map((m) => m[1])
    expect(listed.length).toBeGreaterThanOrEqual(6)
    for (const path of listed) expect(path.startsWith('/api/voice/operator-line/')).toBe(true)
    expect(OPERATOR_INBOUND_URL).toBe('https://<published host>/api/voice/operator-line/inbound')
    expect(OPERATOR_INBOUND_URL.endsWith('/')).toBe(false)
  })

  it('the runtime still serves POST /voice/:slug', () => {
    const runtime = readFileSync(join(__dirname, '../../../src/runtime/voiceRuntime.ts'), 'utf8')
    expect(runtime).toMatch(/app\.post\(\s*["']\/voice\/:slug["']/)
  })

  it('says repointing is done in the Twilio console and is Wayne\'s decision', () => {
    expect(WHERE_TO_REPOINT).toContain('does not change a number')
    expect(WHERE_TO_REPOINT).toContain('Twilio console')
    expect(WHERE_TO_REPOINT).toContain("Wayne's decision")
  })
})

describe('servableLanes reads /voice/health', () => {
  it('lists only the lanes the build says it can answer, in its order', () => {
    expect(
      servableLanes({
        lanes: [
          { slug: 'optical', servable: true },
          { slug: 'answering-service', servable: false },
          { slug: 'records', servable: true },
          { slug: 'azul-scheduling', servable: false },
          { slug: 'pcp', servable: true },
        ],
      }),
    ).toEqual([
      { slug: 'optical', path: '/voice/optical', outbound: false },
      { slug: 'records', path: '/voice/records', outbound: false },
      { slug: 'pcp', path: '/voice/pcp', outbound: false },
    ])
  })

  it('marks an outbound campaign, whose caller-ID number is pointed at /voice/<lane>', () => {
    // The dialler rings nobody unless the caller ID's Voice URL is exactly
    // https://<host>/voice/<lane> (src/runtime/outbound/dialer.ts), so the
    // path is right for NPX; the note says which number.
    const dialer = readFileSync(join(__dirname, '../../../src/runtime/outbound/dialer.ts'), 'utf8')
    expect(dialer).toContain('const want = `${VOICE_PATH_PREFIX}/${slug}`')
    expect(
      servableLanes({
        lanes: [
          { slug: 'npx-outreach', servable: true, outboundMode: 'demo' },
          { slug: 'tech', servable: true, outboundMode: null },
        ],
      }),
    ).toEqual([
      { slug: 'npx-outreach', path: '/voice/npx-outreach', outbound: true },
      { slug: 'tech', path: '/voice/tech', outbound: false },
    ])
    expect(servableLanes({ lanes: [{ slug: 'npx-outreach', servable: true, outboundMode: 'live' }] })?.[0].outbound).toBe(true)
  })

  it('lists no lane when the build says it is not live-ready', () => {
    const health = {
      liveReady: false,
      missing: ['XAI_API_KEY', 'PRODUCTION_DATABASE_URL (or DATABASE_URL)'],
      lanes: [{ slug: 'optical', servable: true }],
    }
    expect(servableLanes(health)).toEqual([])
    expect(notLiveReady(health)).toEqual(['XAI_API_KEY', 'PRODUCTION_DATABASE_URL (or DATABASE_URL)'])
    expect(notLiveReady({ liveReady: true, lanes: [] })).toBeNull()
    expect(notLiveReady({ lanes: [] })).toBeNull()
    expect(notLiveReady(undefined)).toBeNull()
    expect(notLiveReady({ liveReady: false })).toEqual([])
    // Names only: anything that is not an env-var name is dropped.
    expect(notLiveReady({ liveReady: false, missing: ['OK_NAME', '<script>', 7 as unknown as string] })).toEqual(['OK_NAME'])
    expect(slugs({ liveReady: true, lanes: [{ slug: 'optical', servable: true }] })).toEqual(['optical'])
  })

  it('knows a workspace host from a published one', () => {
    expect(isWorkspaceHost('dcf9f10f-abc-3uh0nmdcvfbs6.spock.replit.dev')).toBe(true)
    expect(isWorkspaceHost('example.REPLIT.DEV:443')).toBe(true)
    expect(isWorkspaceHost('old.repl.co')).toBe(true)
    expect(isWorkspaceHost('openai-realtime-api-voice-assistant-remix--fabianwayne1.replit.app')).toBe(false)
    expect(isWorkspaceHost('replit.dev.example.com')).toBe(false)
    expect(isWorkspaceHost('')).toBe(false)
  })

  it('answers null when there is no lane list, and [] when none is servable', () => {
    expect(servableLanes(undefined)).toBeNull()
    expect(servableLanes(null)).toBeNull()
    expect(servableLanes({})).toBeNull()
    expect(servableLanes({ lanes: null })).toBeNull()
    expect(servableLanes({ lanes: [{ slug: 'tech', servable: false }] })).toEqual([])
  })

  it('drops a slug that is not a lane name, and a duplicate', () => {
    expect(
      slugs({
        lanes: [
          { slug: 'tech', servable: true },
          { slug: 'tech', servable: true },
          { slug: '../admin', servable: true },
          { slug: 'Tech', servable: true },
          { slug: '', servable: true },
          // A truthy non-boolean is not "servable".
          { slug: 'surgery', servable: 'yes' as unknown as boolean },
        ],
      }),
    ).toEqual(['tech'])
  })
})

describe('the Twilio page card (source pin)', () => {
  const page = readFileSync(join(__dirname, '../pages/TwilioPage.tsx'), 'utf8')
  const start = page.indexOf('{/* Production Endpoint Reference')
  const end = page.indexOf('<Dialog open={showConfigureDialog}')
  const card = page.slice(start, end)

  it('finds the card', () => {
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    expect(card).toContain('Production Endpoint Reference')
  })

  it('no longer lists the retired patterns', () => {
    expect(page).not.toContain('/api/voice/inbound')
    expect(page).not.toContain('?agent=')
    expect(page).not.toContain('X-Agent-Slug')
    expect(page).not.toContain('SIP Header Routing')
    expect(page).not.toContain('YOUR_DOMAIN')
  })

  it('writes no phone number into the page', () => {
    // (909) 413-5645 was labelled answering-service; it carries records on the
    // runtime. Numbers belong to Twilio, read live, not to this page.
    expect(page).not.toMatch(/\(\d{3}\)\s*\d{3}-\d{4}/)
    expect(page).not.toMatch(/\+1\d{10}/)
    expect(page).not.toMatch(/\b\d{3}[-.]\d{3}[-.]\d{4}\b/)
    expect(card).not.toContain('Known Production Numbers')
  })

  it('shows the three true things from the shared module', () => {
    expect(card).toContain('{RUNTIME_URL_SHAPE}')
    expect(card).toContain('{OPERATOR_INBOUND_URL}')
    expect(card).toContain('{WHERE_TO_REPOINT}')
  })

  it('lists lanes from /voice/health, never from the agents table', () => {
    expect(page).toContain("fetch('/voice/health'")
    expect(page).toContain('servableLanes(health.data)')
    expect(card).toContain('lanes.map((lane)')
    expect(card).toContain('{lane.path}')
    expect(card).not.toMatch(/\bagents?\b/)
  })

  it('does not call the operator inbound path the only /api/voice path the runtime answers', () => {
    expect(card).not.toMatch(/only \/api\/voice path/)
    expect(card).toContain("operator line's inbound Voice URL is exactly this path")
    // Its fallback reaches the runtime too (Codex on #537), so the card names it
    // rather than saying any other /api/voice Voice URL reaches the old pipeline.
    expect(card).not.toContain('Any other inbound /api/voice')
    expect(card).toContain('{OPERATOR_FALLBACK_PATH}')
    expect(card).toContain('{OPERATOR_SMS_PATH}')
    expect(card).toContain("Only the operator line's own listed paths under /api/voice reach")
  })

  it('says when the build cannot answer calls, before listing any lane', () => {
    expect(page).toContain('notLiveReady(health.data)')
    const notReady = card.indexOf('missingForCalls !== null ?')
    const list = card.indexOf('lanes.map((lane)')
    expect(notReady).toBeGreaterThan(-1)
    expect(notReady).toBeLessThan(list)
    expect(card).toContain('not ready to answer calls')
  })

  it('names the host the list came from and warns on a workspace', () => {
    expect(page).toContain('isWorkspaceHost(healthHost)')
    expect(card).toContain('{healthHost')
    expect(card).toContain('{healthIsWorkspace && (')
    expect(card).toContain("this list is the workspace's build")
  })

  it('tells an outbound campaign to point only its caller-ID number at the lane', () => {
    expect(card).toContain('{lane.outbound && (')
    expect(card).toContain('point only its caller-ID number here')
  })
})
