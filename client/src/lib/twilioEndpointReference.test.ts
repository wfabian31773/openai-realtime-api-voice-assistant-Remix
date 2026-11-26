import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  OPERATOR_INBOUND_PATH,
  OPERATOR_INBOUND_URL,
  RUNTIME_URL_SHAPE,
  WHERE_TO_REPOINT,
  runtimePathFor,
  servableLanes,
} from './twilioEndpointReference'

describe('the endpoint reference says only what the running code serves', () => {
  it('names the runtime URL shape with a placeholder host', () => {
    expect(RUNTIME_URL_SHAPE).toBe('https://<published host>/voice/<lane>')
    expect(runtimePathFor('records')).toBe('/voice/records')
  })

  it('names the operator line exactly as server/index.ts lets it past the proxy', () => {
    const index = readFileSync(join(__dirname, '../../../server/index.ts'), 'utf8')
    expect(index).toContain(`'${OPERATOR_INBOUND_PATH}'`)
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
    ).toEqual(['optical', 'records', 'pcp'])
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
      servableLanes({
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
    expect(card).toContain('runtimePathFor(slug)')
    expect(card).toContain('lanes.map((slug)')
    expect(card).not.toMatch(/\bagents?\b/)
  })
})
