/**
 * The production wiring of the after-hours on-call chain: the config read
 * from the environment, the Hub store, the rotation cache, the Twilio senders
 * and the runner, built once at boot by `voiceRuntime`.
 *
 * Nothing here reaches the database or Twilio at import or at build time:
 * the store's query, the console pool and the Twilio client are all opened on
 * first use. A deployment with `ON_CALL_ROTATION_MODE` unset (the default, and
 * today's behaviour) gets a draining runner whose first tick asks the Hub
 * whether the on-call tables exist and any chain is still open; with no
 * tables it asks once more after the store's ten-minute re-check and then
 * stops for good. It never reaches Twilio unless a chain was left open.
 */
import { getConsolePool, isVerificationConfigured } from "../../services/patientVerification";
import type { OnCallTransferWiring } from "../runtimeTransfer";
import { e164, onCallHealth, readOnCallConfig, rotationCallerId, type OnCallConfig } from "./config";
import { createRotationCache } from "./routing";
import { createOnCallRunner, type OnCallRunner, type OnCallRunnerDeps } from "./runner";
import { createPgOnCallStore, type OnCallStore, type Query } from "./store";

type Env = Record<string, string | undefined>;

interface MinimalTwilio {
  messages: { create(opts: { body: string; from: string; to: string }): Promise<{ sid: string }> };
  calls: {
    (sid: string): { update(opts: { status: "completed" }): Promise<unknown> };
    create(opts: {
      to: string;
      from: string;
      twiml: string;
      statusCallback: string;
      statusCallbackMethod: "POST";
      timeout: number;
      timeLimit: number;
    }): Promise<{ sid: string }>;
  };
}

export interface OnCallWiringDeps {
  /** Injected for tests; production opens a Twilio client on first use. */
  twilio?: () => Promise<MinimalTwilio>;
  /** Injected for tests; production uses the Hub pool. */
  store?: OnCallStore;
  /** Injected for tests: the Hub query the production store runs, when no store is given. */
  hubQuery?: Query;
  /** Injected for tests; production uses the Console pool when it is configured. */
  consoleQuery?: Query | null;
  now?: () => Date;
  log?: (line: string) => void;
}

export interface OnCallWiring {
  config: OnCallConfig;
  /** What /voice/health reports. Never a phone number. */
  health: ReturnType<typeof onCallHealth> & { running: boolean; blockedBy?: string };
  /** Null when the chain is off; the transfer then runs exactly as before. */
  transfer: OnCallTransferWiring | null;
  /**
   * The ack and status webhooks' runner. When the chain is off this is a
   * draining runner that only finishes chains left open from before the
   * switch-off (review of #514, round 15): it opens none and rings nobody.
   */
  runner: OnCallRunner | null;
}

/**
 * Builds the chain. It runs only when the mode is test or live AND the
 * deployment has a public host (the provider-call webhooks are reached on
 * it). Anything else returns no transfer wiring, so the after-hours transfer
 * behaves exactly as it does today, and a draining runner for the chains a
 * switch-off left open.
 */
export function buildOnCallWiring(env: Env, host: string | undefined, deps: OnCallWiringDeps = {}): OnCallWiring {
  const config = readOnCallConfig(env);
  const log = deps.log ?? ((line: string) => console.log(line));
  const now = deps.now ?? (() => new Date());

  let client: Promise<MinimalTwilio> | null = null;
  const twilio =
    deps.twilio ??
    (() => {
      if (!client) {
        client = import("twilio").then(
          ({ default: make }) => make(env.TWILIO_ACCOUNT_SID, env.TWILIO_AUTH_TOKEN) as unknown as MinimalTwilio,
        );
      }
      return client;
    });

  const sendSms: OnCallRunnerDeps["sendSms"] = async (input) => {
    const m = await (await twilio()).messages.create({ body: input.body, from: input.from, to: input.to });
    return { sid: m.sid };
  };

  // The text that says nobody took the call goes where today's urgent text
  // goes. It is sent from the chain's own caller ID, the number its other
  // texts already come from: the config always holds one, has checked it is
  // not the operator line, and a deployment that sets ON_CALL_CALLER_ID and
  // not TWILIO_PHONE_NUMBER still gets this text (review of #514). A test
  // chain's goes to the first test phone instead, so a test call never asks
  // a real person to call a test caller back.
  const notifyUrgentFrom = (cfg: OnCallConfig): OnCallRunnerDeps["notifyUrgent"] => async (body, mode, plan) => {
    const test = mode === "test";
    // Normalised the way every other number the rotation reads is, so a
    // number written with punctuation still reaches Twilio, and one that
    // is not a phone number is said to be one rather than refused by
    // Twilio with nothing in the log naming the setting (review of #514,
    // round 4).
    const raw = env.URGENT_NOTIFICATION_NUMBER?.trim();
    // A test chain the rotation outlived (switched to live while it ran)
    // has no test list left; the first number its own plan rang is a test
    // number, so its closing text goes there (review of #514, round 6).
    const to = test
      ? (cfg.testPhones[0] ?? plan?.levels.map((l) => e164(l.phone)).find((p): p is string => !!p) ?? null)
      : e164(raw);
    const from = cfg.callerId;
    if (!to || !from) {
      log(
        !from
          ? "[ON-CALL] the 'nobody took it' text was not sent: no caller ID (ON_CALL_CALLER_ID or TWILIO_PHONE_NUMBER)"
          : test
            ? "[ON-CALL] the 'nobody took it' text was not sent: a test chain needs ON_CALL_TEST_PHONES"
            : raw
              ? "[ON-CALL] the 'nobody took it' text was not sent: URGENT_NOTIFICATION_NUMBER is not a phone number"
              : "[ON-CALL] the 'nobody took it' text was not sent: URGENT_NOTIFICATION_NUMBER is not set",
      );
      return;
    }
    await (await twilio()).messages.create({ body, from, to });
  };

  const endCall: OnCallRunnerDeps["endCall"] = async (sid) => {
    await (await twilio()).calls(sid).update({ status: "completed" });
  };

  if (config.mode === "off" || !host) {
    // The rotation is not running, but a chain opened before it was switched
    // off (or before a republish lost the host) may still be open: one of its
    // provider calls can still ring, and its key press and status must still
    // land (review of #514, round 15). This runner finishes those chains and
    // nothing else: no chain is opened (the transfer gets no wiring), no
    // provider is texted or called, and a chain that would ring its next level
    // is closed with one text to the urgent number. Its first tick finds out
    // whether anything is open; nothing reaches the Hub or Twilio before that.
    const blockedBy = config.mode === "off" ? undefined : "no public host: the provider-call webhooks cannot be reached";
    const drainConfig: OnCallConfig = { ...config, callerId: rotationCallerId(env) ?? "" };
    const drainLog = (line: string) => {
      // The store's notice that the tables are absent is the default
      // deployment's every boot; the drain says what it did in its own words.
      if (line.startsWith("[on-call] the on_call_* tables are")) return;
      log(line);
    };
    const drainStore =
      deps.store ?? createPgOnCallStore(deps.hubQuery, { log: drainLog, now: () => now().getTime() });
    const refuse = async (): Promise<never> => {
      throw new Error("the on-call rotation is off; nothing is sent");
    };
    const runner = createOnCallRunner({
      store: drainStore,
      config: drainConfig,
      host: host ?? "",
      sendSms: refuse,
      placeCall: refuse,
      endCall,
      notifyUrgent: notifyUrgentFrom(drainConfig),
      now,
      log,
      draining: true,
    });
    return {
      config,
      health: { ...onCallHealth(config), running: false, ...(blockedBy ? { blockedBy } : {}) },
      transfer: null,
      runner,
    };
  }

  const store = deps.store ?? createPgOnCallStore(deps.hubQuery, { log, now: () => now().getTime() });
  const rotation = createRotationCache(store, () => now().getTime());

  const runner = createOnCallRunner({
    store,
    config,
    host,
    sendSms,
    placeCall: async (input) => {
      const call = await (await twilio()).calls.create({
        to: input.to,
        from: input.from,
        twiml: input.twiml,
        statusCallback: input.statusCallback,
        statusCallbackMethod: "POST",
        timeout: input.timeout,
        timeLimit: input.timeLimit,
      });
      return { sid: call.sid };
    },
    // Hangs up one of our own provider calls: one still ringing when another
    // call took the patient, or one whose status never came back.
    endCall,
    notifyUrgent: notifyUrgentFrom(config),
    now,
    log,
  });

  const consoleQuery =
    deps.consoleQuery !== undefined
      ? deps.consoleQuery
      : isVerificationConfigured()
        ? (text: string, params?: unknown[]) => getConsolePool().query(text, params as any[])
        : null;

  return {
    config,
    health: { ...onCallHealth(config), running: true },
    transfer: { runner, config, store, rotation, consoleQuery, sendSms, now },
    runner,
  };
}
