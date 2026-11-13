/**
 * The Observatory's pages show every ticket a call created (v223), from the
 * API's `ticketNumbers`, and read the same as before against a server that
 * sends only `ticketNumber`.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { ticketNumbersOf } from './callTickets'

describe('ticketNumbersOf', () => {
  it("shows every ticket the server reports, in its order", () => {
    // CA2b13aabe41c7a684b202f8675f4be1c8 (pcp, 2026-11-06): one ticket per patient.
    expect(ticketNumbersOf({ ticketNumber: 'PCP-81745', ticketNumbers: ['PCP-81745', 'PCP-81747'] })).toEqual([
      'PCP-81745',
      'PCP-81747',
    ])
  })

  it('falls back to the single column against a server older than v223', () => {
    expect(ticketNumbersOf({ ticketNumber: 'VA-1' })).toEqual(['VA-1'])
    expect(ticketNumbersOf({ ticketNumber: 'VA-1', ticketNumbers: [] })).toEqual(['VA-1'])
  })

  it('no ticket is an empty list', () => {
    expect(ticketNumbersOf({})).toEqual([])
    expect(ticketNumbersOf(null)).toEqual([])
    expect(ticketNumbersOf(undefined)).toEqual([])
    expect(ticketNumbersOf({ ticketNumber: '  ' })).toEqual([])
  })

  it('keeps strings only, trimmed, each once', () => {
    expect(ticketNumbersOf({ ticketNumbers: [' VA-2 ', 'VA-2', 7, null, 'PCP-3'] })).toEqual(['VA-2', 'PCP-3'])
  })
})

describe('the pages read it', () => {
  const page = (name: string) => readFileSync(path.resolve(__dirname, '..', 'pages', name), 'utf8')

  it('the call log, the urgent calls list and the call page all show every ticket', () => {
    for (const name of ['CallLogsPage.tsx', 'UrgentCallsPage.tsx', 'CallDetailsPage.tsx']) {
      const src = page(name)
      expect(src, name).toMatch(/import \{ ticketNumbersOf \} from '(@\/lib|\.\.\/lib)\/callTickets'/)
      expect(src, name).toMatch(/ticketNumbersOf\((log|call)\)/)
    }
  })

  it('no page renders the single column as the whole answer any more', () => {
    expect(page('CallLogsPage.tsx')).not.toContain('{(log as any).ticketNumber}')
    expect(page('UrgentCallsPage.tsx')).not.toContain('{call.ticketNumber}')
  })
})
