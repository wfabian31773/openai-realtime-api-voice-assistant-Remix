import { describe, expect, it } from 'vitest';
import { SipConferenceLifecycle } from './sipConferenceLifecycle';

describe('SipConferenceLifecycle', () => {
  it('registers a direct SIP leg so caller-first disconnects can terminate it', () => {
    const lifecycle = new SipConferenceLifecycle();

    lifecycle.registerSipLeg('conf_CAcaller', 'CAsip');

    expect(lifecycle.takeSipLegForConference('conf_CAcaller')).toBe('CAsip');
    expect(lifecycle.takeSipLegForConference('conf_CAcaller')).toBeUndefined();
  });

  it('recovers the conference name from the SIP callback URI after a restart', () => {
    const lifecycle = new SipConferenceLifecycle();
    const to = 'sip:project@sip.api.openai.com;transport=tls?X-conferenceName=conf_CAencoded%2Fvalue&X-agentSlug=no-ivr';

    expect(lifecycle.resolveConferenceName('CAunknown', to)).toBe('conf_CAencoded/value');
  });

  it('requests caller recovery when the Sage leg ends first', () => {
    const lifecycle = new SipConferenceLifecycle();
    lifecycle.registerSipLeg('conf_CAsage', 'CAsip');

    expect(lifecycle.beginCallerRecovery({
      sipCallSid: 'CAsip',
      status: 'completed',
      to: undefined,
      transferredToHuman: false,
    })).toEqual({ conferenceName: 'conf_CAsage' });
  });

  it('does not interrupt a caller after a human has joined the conference', () => {
    const lifecycle = new SipConferenceLifecycle();
    lifecycle.registerSipLeg('conf_CAtransfer', 'CAsip');
    lifecycle.markHumanJoined('conf_CAtransfer');

    expect(lifecycle.beginCallerRecovery({
      sipCallSid: 'CAsip',
      status: 'completed',
      to: undefined,
      transferredToHuman: false,
    })).toBeNull();
  });

  it('does not interrupt a completed transfer even when join telemetry is late', () => {
    const lifecycle = new SipConferenceLifecycle();
    lifecycle.registerSipLeg('conf_CAtransfer', 'CAsip');

    expect(lifecycle.beginCallerRecovery({
      sipCallSid: 'CAsip',
      status: 'completed',
      to: undefined,
      transferredToHuman: true,
    })).toBeNull();
  });

  it('ignores non-terminal callbacks and deduplicates repeated terminal callbacks', () => {
    const lifecycle = new SipConferenceLifecycle();
    lifecycle.registerSipLeg('conf_CAretry', 'CAsip');

    expect(lifecycle.beginCallerRecovery({
      sipCallSid: 'CAsip',
      status: 'in-progress',
      to: undefined,
      transferredToHuman: false,
    })).toBeNull();

    expect(lifecycle.beginCallerRecovery({
      sipCallSid: 'CAsip',
      status: 'failed',
      to: undefined,
      transferredToHuman: false,
    })).toEqual({ conferenceName: 'conf_CAretry' });

    expect(lifecycle.beginCallerRecovery({
      sipCallSid: 'CAsip',
      status: 'failed',
      to: 'sip:project@sip.api.openai.com?X-conferenceName=conf_CAretry',
      transferredToHuman: false,
    })).toBeNull();
  });

  it('allows recovery again only after a previous human participant leaves', () => {
    const lifecycle = new SipConferenceLifecycle();
    lifecycle.markHumanJoined('conf_CAhuman');
    lifecycle.markHumanLeft('conf_CAhuman');
    lifecycle.registerSipLeg('conf_CAhuman', 'CAsip');

    expect(lifecycle.beginCallerRecovery({
      sipCallSid: 'CAsip',
      status: 'busy',
      to: undefined,
      transferredToHuman: false,
    })).toEqual({ conferenceName: 'conf_CAhuman' });
  });

  it('cancels a reserved recovery when a human joins during callback reordering', () => {
    const lifecycle = new SipConferenceLifecycle();
    lifecycle.registerSipLeg('conf_CArace', 'CAsip');
    const plan = lifecycle.beginCallerRecovery({
      sipCallSid: 'CAsip',
      status: 'completed',
      to: undefined,
      transferredToHuman: false,
    });

    lifecycle.markHumanJoined('conf_CArace');

    expect(plan).toEqual({ conferenceName: 'conf_CArace' });
    expect(lifecycle.canExecuteCallerRecovery('conf_CArace', false)).toBe(false);
  });
});
