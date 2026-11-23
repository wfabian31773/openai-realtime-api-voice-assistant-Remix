/**
 * The production wiring of the after-hours on-call chain: the config read
 * from the environment, the Hub store, the rotation cache, the Twilio senders
 * and the runner, built once at boot by `voiceRuntime`.
 *
 * Nothing here reaches the database or Twilio at import or at build time:
 * the store's query, the console pool and the Twilio client are all opened on
 * first use, so a deployment with `ON_CALL_ROTATION_MODE` unset (the default,
 * and today's behaviour) never touches them.
 */
import { getConsolePool, isVerificationConfigured } from "../../services/patientVerification";
import type { OnCallTransferWiring } from "../runtimeTransfer";
import { onCallHealth, readOnCallConfig, type OnCallConfig } from "./config";
import { createRotationCache } from "./routing";
import { createOnCallRunner, type OnCallRunner, type OnCallRunnerDeps } from "./runner";
import { createPgOnCallStore, type OnCallStore, type Query } from "./store";

type Env = Record<string, string | undefined>;

interface MinimalTwilio {
  messages: { create(opts: { body: string; from: string; to: string }): Promise<{ sid: string }> };
  calls: {
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
  /** Null when the chain is off. The ack and status webhooks need it. */
  runner: OnCallRunner | null;
}

/**
 * Builds the chain, or nothing. The chain runs only when the mode is test or
 * live AND the deployment has a public host (the provider-call webhooks are
 * reached on it). Anything else returns a null wiring and a reason, and the
 * after-hours transfer behaves exactly as it does today.
 */
export function buildOnCallWiring(env: Env, host: string | undefined, deps: OnCallWiringDeps = {}): OnCallWiring {
  const config = readOnCallConfig(env);
  const log = deps.log ?? ((line: string) => console.log(line));
  const now = deps.now ?? (() => new Date());

  if (config.mode === "off") {
    return { config, health: { ...onCallHealth(config), running: false }, transfer: null, runner: null };
  }
  if (!host) {
    const blockedBy = "no public host: the provider-call webhooks cannot be reached";
    return { config, health: { ...onCallHealth(config), running: false, blockedBy }, transfer: null, runner: null };
  }

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

  const store = deps.store ?? createPgOnCallStore(undefined, { log });
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
    // The text that says nobody took the call goes where today's urgent text
    // goes, from today's number. It is not a provider call.
    notifyUrgent: async (body) => {
      const to = env.URGENT_NOTIFICATION_NUMBER?.trim();
      const from = env.TWILIO_PHONE_NUMBER?.trim();
      if (!to || !from) {
        log("[ON-CALL] the 'nobody took it' text was not sent: URGENT_NOTIFICATION_NUMBER or TWILIO_PHONE_NUMBER is not set");
        return;
      }
      await (await twilio()).messages.create({ body, from, to });
    },
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
