export type JsonRpcReply =
  | { jsonrpc: "2.0"; id: string | number | null; result: unknown }
  | { jsonrpc: "2.0"; id: string | number | null; error: { code: number; message: string } };

export interface VoiceFleetMcpOptions {
  baseUrl: string;
  /** Plaintext bearer, supplied afresh for each fleet API call. */
  getToken: () => string | Promise<string>;
  timeoutMs?: number;
}

export const SUPPORTED: readonly ["2025-06-18", "2025-03-26", "2024-11-05"];
export function createVoiceFleetMcp(options: VoiceFleetMcpOptions): {
  handleMessage(msg: unknown): Promise<JsonRpcReply | null>;
};
export function mask(value: unknown, key?: string, includeContent?: boolean): unknown;
export function maskString(value: string): string;
export function inCallingWindow(now?: Date): boolean;
export const OPERATOR_PREPARE_FIELDS: string[];
export function operatorPrepareBody(args?: Record<string, unknown>): Record<string, unknown>;
