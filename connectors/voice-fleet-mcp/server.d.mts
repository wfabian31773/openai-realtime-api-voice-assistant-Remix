import type { Readable, Writable } from "node:stream";
import type { Interface } from "node:readline";
export { mask, maskString, inCallingWindow, operatorPrepareBody, OPERATOR_PREPARE_FIELDS } from "./core.mjs";
export function startStdio(input?: Readable, output?: Writable, env?: Record<string, string | undefined>): Interface;
