#!/usr/bin/env node
// Stdio shell. Keep credentials on disk and reload them for every API call.
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { pathToFileURL } from "node:url";
import { createVoiceFleetMcp } from "./core.mjs";
export { mask, maskString, inCallingWindow, operatorPrepareBody, OPERATOR_PREPARE_FIELDS } from "./core.mjs";

export function startStdio(input = process.stdin, output = process.stdout, env = process.env) {
  const tokenFile = env.VOICE_FLEET_TOKEN_FILE || "/home/box/.secrets/voice-fleet-bot.token";
  function token() {
    if (/approve/i.test(tokenFile)) throw new Error("Refusing token file: approve tokens are not allowed in this connector");
    const value = readFileSync(tokenFile, "utf8").trim();
    if (!/^si\.[a-f0-9]{32}\.[a-f0-9]{64}$/.test(value)) throw new Error("Token file does not hold a valid si.<jti>.<secret> token");
    return value;
  }
  const core = createVoiceFleetMcp({
    baseUrl: env.VOICE_FLEET_BASE_URL || "https://openai-realtime-api-voice-assistant-remix--fabianwayne1.replit.app",
    getToken: token,
    timeoutMs: Number(env.VOICE_FLEET_TIMEOUT_MS || 30000),
  });
  return createInterface({ input }).on("line", async (line) => {
    let msg;
    try { msg = JSON.parse(line); } catch { return; }
    const reply = await core.handleMessage(msg);
    if (reply !== null) output.write(JSON.stringify(reply) + "\n");
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) startStdio();
