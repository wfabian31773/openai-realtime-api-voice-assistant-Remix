import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { once } from "node:events";
import { createVoiceFleetMcp, mask, maskString, inCallingWindow, SUPPORTED } from "../../connectors/voice-fleet-mcp/core.mjs";
import { startStdio } from "../../connectors/voice-fleet-mcp/server.mjs";
import originalTools from "../../connectors/voice-fleet-mcp/tools-list-b7f9b822.json";

const call = (name: string, args?: unknown) => ({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: `voice_fleet_${name}`, arguments: args } });
const create = (getToken = () => "synthetic-bearer") => createVoiceFleetMcp({ baseUrl: "http://127.0.0.1:5000/", getToken });

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

describe("voice fleet MCP core", () => {
  it("retains the masking and calling-window exports used by manual tests", () => {
    expect(maskString("call +1 (909) 555-0113 now")).toBe("call ***-***-0113 now");
    expect(mask({ phone: "9095550113", firstName: "Synthetic", nested: [{ dateOfBirth: "synthetic-dob", note: "synthetic@example.test" }] })).toEqual({ phone: "***-***-0113", firstName: "[redacted 9 chars]", nested: [{ dateOfBirth: "[redacted 13 chars]", note: "[email]" }] });
    expect(mask({ body: "Synthetic private body", name: "Synthetic Person", email: "synthetic@example.test" }, "", true)).toEqual({ body: "Synthetic private body", name: "[redacted 16 chars]", email: "[redacted 22 chars]" });
    expect(maskString(`si.${"a".repeat(32)}.${"b".repeat(64)} ${"c".repeat(64)}`)).toBe("[redacted] [redacted]");
    for (const [time, allowed] of [["2026-10-27T16:00:00Z", true], ["2026-10-27T15:59:00Z", false], ["2026-10-28T03:00:00Z", false], ["2026-11-23T17:00:00Z", true]] as const) expect(inCallingWindow(new Date(time))).toBe(allowed);
  });

  it("retains tools/list bytes from b7f9b822 except the intentional requested_by schema addition", async () => {
    const reply = await create().handleMessage({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    const tools = originalTools.map((tool) => tool.name !== "voice_fleet_operator_prepare_call" ? tool : {
      ...tool, inputSchema: { ...tool.inputSchema, properties: {
        ...tool.inputSchema.properties,
        requested_by: { type: "string", enum: ["owner_request", "bot_initiative"], description: "Alias for initiated_by; both must agree when supplied" },
      } },
    });
    expect(JSON.stringify(reply)).toBe(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools } }));
  });

  it.each([
    ["+44 20 7946 0000", "***-***-0000"],
    ["+44-20-7946-0001", "***-***-0001"],
    ["+442079460002", "***-***-0002"],
    ["+44 (20) 7946-0000", "***-***-0000"],
    ["+44.20.7946.0000", "***-***-0000"],
    ["+44(20)7946.0003", "***-***-0003"],
    ["+44 . (20) - 7946 . 0004", "***-***-0004"],
    // Unassigned country code for synthetic 8- and 15-digit boundaries.
    ["+99990000", "***-***-0000"],
    ["+999999999990000", "***-***-0000"],
    ["9095550113", "***-***-0113"],
    ["909-555-0113", "***-***-0113"],
    ["909.555.0113", "***-***-0113"],
    ["(909) 555-0113", "***-***-0113"],
    ["+19095550113", "***-***-0113"],
    ["+1 (909) 555-0113", "***-***-0113"],
    ["+19095550113 123", "***-***-3123"],
    ["+44 20 7946 0958 (1234)", "***-***-0958"],
    ["+44 20 7946 0958(1234)", "***-***-0958"],
    ["+44 20 7946 0958 (123)", "***-***-0958"],
    ["+44 20 7946 0958 (1)", "***-***-0958"],
    ["+44 20 7946 0958 x123", "***-***-0958"],
    ["+44 20 7946 0958x123", "***-***-0958"],
    ["+44 20 7946 0958X123", "***-***-0958"],
    ["+44 20 7946 0958 ext. 45", "***-***-0958"],
    ["+44 20 7946 0958 #12", "***-***-0958"],
    ["+44 20 7946 0958/12", "***-***-5812"],
    ["+44 (20) 7946-0958 (12)", "***-***-0958"],
    ["+1 909 555 0113 x45", "***-***-0113"],
    ["+19095550113x45", "***-***-0113"],
    ["9095550113x45", "***-***-0113"],
    ["+99990000 (12)", "***-***-0000"],
    ["+999999999990000 (12)", "***-***-0000"],
    ["+9990000", "***-***-0000"],
    ["+9999999999990000", "***-***-0000"],
    ["+99.99.99.99.99.99.00.00", "***-***-0000"],
  ])("masks synthetic phone %s to %s in strings, fields and included content", (phone, expected) => {
    expect(maskString(`Call ${phone} now`)).toBe(`Call ${expected} now`);
    expect(mask({ phone, note: `Call ${phone}` })).toEqual({ phone: expected, note: `Call ${expected}` });
    expect(mask({ phone, body: `Call ${phone}`, nested: [{ text: phone }] }, "", true))
      .toEqual({ phone: expected, body: `Call ${expected}`, nested: [{ text: expected }] });
  });

  it.each([
    ["555/0100", "***-***-0100"],
    ["(909)\n555-0113", "***-***-0113"],
    ["+44\u00A020\u202F7946\u20130958 x\n123", "***-***-0958"],
    ["555\\t0100", "***-***-0100"],
    ["+44 20 7946 0958 x\r12\u200B3456", "***-***-0958"],
    ["+44 20 7946 0958\n(12)\u202F(34)", "***-***-0958"],
    ["555\t0100", "***-***-0100"],
    ["+9990000(00)0100", "***-***-0100"],
    ["555010", "555010"],
    ["prefix5550100suffix", "prefix***-***-0100suffix"],
    ["+44 20 7946 0958 x 12345", "***-***-0958"],
    ["+44 20 7946 0958 ext.123456", "***-***-0958"],
    ["+44 20 7946 0958 (123456)", "***-***-0958"],
    ["+44 20 7946 0958 (12)", "***-***-0958"],
    ["+44 20 7946 0958 (1234)", "***-***-0958"],
    ["+44 20 7946 0958 x1234", "***-***-0958"],
    ["+44 20 7946 0958 #1234", "***-***-0958"],
    ["+44 20 7946 0958 x12 3456", "***-***-0958"],
    ["+44 20 7946 0958 (12) (34)", "***-***-0958"],
    ["+44 20 7946 0958 x12 #345", "***-***-0958"],
    ["555010x12345", "***-***-2345"],
    ["555x0100", "***-***-0100"],
    ["5550100x12;3456789", "***-***-0100"],
    ["5550100 ext.12,3456789", "***-***-0100"],
    ["5550100(12);3456789", "***-***-6789"],
  ])("conservatively masks digit runs and suffixes: %s", (input, expected) => {
    expect(maskString(input)).toBe(expected);
    expect(mask({ note: input })).toEqual({ note: expected });
    for (const key of ["body", "text", "transcript", "turns"]) {
      expect(mask({ [key]: input }, "", true)).toEqual({ [key]: expected });
    }
  });

  it.each([
    ["＋１（２０２）５５５－０１０３", "***-***-0103"],
    ["٢٠٢·٥٥٥·٠١٠٣", "***-***-0103"],
    ["۲۰۲\u200D۵۵۵\u2060۰۱۰۳", "***-***-0103"],
    ["२०२／५५५．०१०३", "***-***-0103"],
    ["২০২\u0085৫৫৫\u200C০১০৩", "***-***-0103"],
    ["๒๐๒\uFEFF๕๕๕\u200B๐๑๐๓", "***-***-0103"],
    ["𝟐𝟎𝟐‐𝟓𝟓𝟓‐𝟎𝟏𝟎𝟑", "***-***-0103"],
    ["２０２５５５０１０３ ｅｘｔ． １２３４", "***-***-0103"],
    ["２０２５５５０１０３Ｘ१२३४५", "***-***-0103"],
    ["２０２５５５０１０３ ＃๑๒", "***-***-0103"],
    ["２０２５５５０１０３（১২）", "***-***-0103"],
    ["２０２５５５０１０３（১২৩）", "***-***-0103"],
    ["２０２５５５０１０３（১২৩৪৫）", "***-***-0103"],
  ])("masks Unicode digits and separators without normalizing surrounding text: %s", (input, expected) => {
    // Compatibility expansions, combining marks and astral characters exercise
    // original UTF-16 offsets on both sides of multiple matches. An opaque id
    // separates independent phones from a conservatively consumed extension.
    const wrap = (phone: string) => `𝄞 ﬃ Ａ e\u0301 ${phone}; {"id":"12345678901234567890"}; ${phone} ㍿`;
    expect(maskString(wrap(input))).toBe(wrap(expected));
    expect(mask({ note: wrap(input) })).toEqual({ note: wrap(expected) });
    expect(mask({ body: [{ text: wrap(input) }] }, "", true))
      .toEqual({ body: [{ text: wrap(expected) }] });
  });

  it("masks every decimal digit set supported by the runtime with ASCII last four", () => {
    for (let code = 0; code <= 0x10ffff; code++) {
      if (!/\p{Nd}/u.test(String.fromCodePoint(code))) continue;
      const digits = Array.from({ length: 10 }, (_, i) => String.fromCodePoint(code + i)).join("");
      expect(maskString(digits), `decimal set U+${code.toString(16)}`).toBe("***-***-6789");
      code += 9;
    }
  });

  it("protects complete ISO dates/timestamps, UUIDs, SIDs and typed id values before masking", () => {
    const tokens = [
      "2026-11-23", "2026-11-23T10:30:00Z", "2026-11-23T10:30:00.123456Z",
      "2026-11-23T10:30:00.123-05:00", "2026-11-23T10:30:00+0530",
      "12345678-1234-4123-8123-123456789012",
      ...["CA", "PN", "SM", "MM", "RE", "AC"].map((prefix) => prefix + "123456789012345678901234567890ab"),
    ];
    const ids = {
      id: "12345678901234567890", callId: "9876543210123456", ticketId: "ticket-1234567890",
      customer_id: "1234567890123", sid: "123456789012345678", recordingSid: "recording_1234567890",
      createdAt: "1795433400123", updated_at: "1795433400456", eventTimestamp: "1795433400789",
      timestamp: 1795433400123, legacyId: "-123456789012345",
    };
    for (const token of tokens) {
      const text = `Synthetic token ${token}; call 555/0100.`;
      const expected = `Synthetic token ${token}; call ***-***-0100.`;
      expect(maskString(text)).toBe(expected);
      expect(mask({ note: text })).toEqual({ note: expected });
      expect(mask({ body: text, turns: [{ text }] }, "", true)).toEqual({ body: expected, turns: [{ text: expected }] });
    }
    expect(mask(ids)).toEqual(ids);
    expect(mask({ body: ids }, "", true)).toEqual({ body: ids });
    const json = JSON.stringify({ ...ids, phone: "5550100" });
    const expectedJson = JSON.stringify({ ...ids, phone: "***-***-0100" });
    expect(maskString(json)).toBe(expectedJson);
    expect(mask({ note: json })).toEqual({ note: expectedJson });
    expect(mask({ text: json }, "", true)).toEqual({ text: expectedJson });
    expect(mask({ id: "Call 5550100", note: "12345678901234567890" }))
      .toEqual({ id: "Call ***-***-0100", note: "***-***-7890" });
    // Input cannot impersonate the internal placeholders.
    const literal = "\uE000aaaaaaaa\uE001\uE000\uE000";
    expect(maskString(`${literal} 5550100 2026-11-23`))
      .toBe(`${literal} ***-***-0100 2026-11-23`);
    expect(maskString("\uE000p\uE000 5550100 2026-11-23"))
      .toBe("\uE000p\uE000 ***-***-0100 2026-11-23");
  });

  it("restores 1,000 ISO date tokens in under 50 ms", () => {
    const input = Array.from({ length: 1000 }, (_, i) => `2026-11-${String(i % 28 + 1).padStart(2, "0")}`).join(" ");
    maskString(input);
    const start = performance.now();
    const output = maskString(input);
    const elapsed = performance.now() - start;
    expect(output).toBe(input);
    expect(elapsed).toBeLessThan(50);
  });

  it("masks phones split by every combining mark, format and control character supported by the runtime", () => {
    for (let code = 0; code <= 0x10ffff; code++) {
      const point = String.fromCodePoint(code);
      if (!/[\p{M}\p{Cf}\p{Cc}]/u.test(point)) continue;
      const phone = `٥５𝟓${point}०১๐０`;
      expect(maskString(phone), `U+${code.toString(16)}`).toBe("***-***-0100");
      expect(mask({ body: [{ text: phone }] }, "", true)).toEqual({ body: [{ text: "***-***-0100" }] });
    }
  });

  it.each(["a", " a ", "abc", "Ж", "字", "[]", "{}", "_", "*", "~", ",", ";", ":", "\"", "\\", "\uE000aaaaaaaa\uE001", "\uE000\uE000", "\uE000aaaaaaab\uE001"])(
    "masks synthetic digit groups split by %s", (separator) => {
      const input = `555${separator}0100`;
      expect(maskString(input)).toBe("***-***-0100");
      expect(mask({ note: input })).toEqual({ note: "***-***-0100" });
      for (const key of ["body", "text", "transcript", "turns", "messages"]) {
        expect(mask({ [key]: [{ nested: [input] }] }, "", true))
          .toEqual({ [key]: [{ nested: ["***-***-0100"] }] });
      }
      expect(maskString(JSON.stringify({ note: input }))).toBe('{"note":"***-***-0100"}');
    },
  );

  it.each([
    ["⓹⓹⓹⓿❶⓿⓿", "0100"], ["❺❺❺⓿❶⓿⓿", "0100"],
    ["➄➄➄🄋➀🄌🄋", "0100"], ["➎➎➎⓿➊⓿⓿", "0100"],
    ["⑤⁵₅⓪¹₀０", "0100"], ["፭፭፭፩፩፩፩", "1111"],
    ["\u{102e5}\u{102e5}\u{102e5}\u{102e1}\u{102e1}\u{102e1}\u{102e1}", "1111"],
    ["⓫⓫⓫⓫", "1111"],
  ])("masks enclosed and non-decimal script digits: %s", (input, tail) => {
    expect(maskString(input)).toBe(`***-***-${tail}`);
    expect(mask({ body: { messages: [input] } }, "", true)).toEqual({ body: { messages: [`***-***-${tail}`] } });
  });

  it("does not exempt phone-looking typed values, inline JSON, or oversized date fractions", () => {
    for (const key of ["id", "sid", "callId", "ticketId", "createdAt", "updated_at", "timestamp"]) {
      for (const phone of ["5550100", "2025550103", "202-555-0103", "2025550103x1234"]) {
        const expected = phone === "5550100" ? "***-***-0100" : "***-***-0103";
        expect(mask({ [key]: phone })).toEqual({ [key]: expected });
        expect(mask({ body: { [key]: phone } }, "", true)).toEqual({ body: { [key]: expected } });
        expect(maskString(JSON.stringify({ [key]: phone }))).toBe(JSON.stringify({ [key]: expected }));
        expect(maskString(`record {"${key}":"${phone}"}`)).toBe(`record {"${key}":"${expected}"}`);
      }
    }
    expect(mask({ id: "phone-2025550103" })).toEqual({ id: "phone-***-***-0103" });
    expect(maskString('{"id":"phone-2025550103"}')).toBe('{"id":"phone-***-***-0103"}');
    for (const input of ["555-2026-11-23-0100", "555 2026-11-23 0100", "555\u03012026-11-23\u200e0100", "555-12345678-1234-4123-8123-123456789012-0100", `555 CA${"a".repeat(32)} 0100`, "2026-11-23T10:30:00.5550100Z"]) {
      expect(maskString(input)).toBe(input.endsWith("Z") ? "***-***-0100Z" : "***-***-0100");
    }
    expect(maskString("xx5550100aaaaaaaaaaaaaaaaaaaaaaaaa")).toBe("xx***-***-0100aaaaaaaaaaaaaaaaaaaaaaaaa");
    expect(maskString("55501000-1234-9999-1111-123456789012")).toBe("***-***-9012");
  });

  it("masks escaped and repeatedly serialized JSON strings and their keys", () => {
    for (const input of [
      '{"note":"\\u0035\\u0035\\u0035\\u0030\\u0031\\u0030\\u0030"}',
      '{"note":"555\\u200e0100"}',
      '{"note":"555\\u00ad0100"}',
      '{"note":"\\ud835\\udfd3\\ud835\\udfd3\\ud835\\udfd3\\ud835\\udfce\\ud835\\udfcf\\ud835\\udfce\\ud835\\udfce"}',
    ]) {
      const expected = '{"note":"***-***-0100"}';
      expect(maskString(input)).toBe(expected);
      expect(maskString(JSON.stringify(JSON.stringify(input)))).toBe(JSON.stringify(JSON.stringify(expected)));
      expect(mask({ messages: [{ text: input }] }, "", true)).toEqual({ messages: [{ text: expected }] });
    }
    const input = { "5550100": { "202_555_0103": 2025550103 } };
    const expected = { "***-***-0100": { "***-***-0103": "***-***-0103" } };
    expect(mask(input)).toEqual(expected);
    expect(mask({ body: [input] }, "", true)).toEqual({ body: [expected] });
    expect(maskString(JSON.stringify(input))).toBe(JSON.stringify(expected));
  });

  it.each([
    [5550100, "0100"], [2025550103, "0103"], [-2025550103, "0103"],
    [202.5550103, "0103"], [1e21, "0000"],
  ])("masks numeric values outside protected id fields: %s", (input, tail) => {
    const expected = input < 0 ? `-***-***-${tail}` : `***-***-${tail}`;
    expect(mask({ note: input })).toEqual({ note: expected });
    expect(mask({ body: { turns: [[{ value: input }]] } }, "", true))
      .toEqual({ body: { turns: [[{ value: expected }]] } });
    expect(maskString(JSON.stringify({ note: input }))).toBe(JSON.stringify({ note: expected }));
  });

  it("redacts split digit arrays, including nested arrays and arrays beside prose", () => {
    for (const input of [["555", "0100"], ["555", " ", "0100"], ["555", "_", "0100"], ["5", "5", "5", "0", "1", "0", "0"], ["555", ["0", ["1", "00"]]], ["call", "555", "0100", { note: "5550100" }]]) {
      const output = mask({ note: input }) as { note: unknown };
      expect(JSON.stringify(output)).not.toMatch(/\d{5}/);
      expect(JSON.stringify(output)).not.toContain('"555"');
      expect(JSON.stringify(output)).toContain("[redacted digits]");
      expect(mask({ transcript: { turns: input } }, "", true)).toEqual({ transcript: { turns: output.note } });
      expect(maskString(JSON.stringify({ note: input }))).toBe(JSON.stringify(output));
    }
    // Digit splitting does not change the existing standalone token exceptions.
    const tokens = ["2026-11-23", "2026-11-23T10:30:00.123456Z", "12345678-1234-4123-8123-123456789012"];
    expect(mask({ note: tokens })).toEqual({ note: tokens });
  });

  it.each([
    ["operator_inbound_get", "callSid", "CA"],
    ["operator_sms_get", "messageSid", "SM"],
    ["operator_voicemail_get", "recordingSid", "RE"],
  ])("masks adversarial content through %s includeContent", async (name, sidKey, prefix) => {
    const data = {
      body: "555\u00ad0100", text: "555\u03010100", transcript: [{ id: "5550100" }],
      turns: [{ "5550100": ["555", "0100"] }], messages: [{ text: '{"id":"5550100"}', value: 5550100 }],
    };
    const expected = {
      body: "***-***-0100", text: "***-***-0100", transcript: [{ id: "***-***-0100" }],
      turns: [{ "***-***-0100": ["[redacted digits]", "[redacted digits]"] }],
      messages: [{ text: '{"id":"***-***-0100"}', value: "***-***-0100" }],
    };
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(data));
    const reply = await create().handleMessage(call(name, { [sidKey]: prefix + "a".repeat(32), includeContent: true }));
    const wire = JSON.parse(JSON.stringify(reply));
    expect(wire.result.isError).toBe(false);
    expect(JSON.parse(wire.result.content[0].text).data).toEqual(expected);
  });

  it("leaves no unprotected 7+ digit run across seeded synthetic phone formats and extensions", () => {
    let seed = 0x5eed1234;
    const random = (max: number) => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed % max;
    };
    const separators = [
      "", " ", "\t", "\n", "\r", "\f", "\v", ".", "-", "/", " . ", " - ",
      "\u00A0", "\u1680", ...Array.from({ length: 12 }, (_, i) => String.fromCharCode(0x2000 + i)),
      "\u202F", "\u205F", "\u3000", "\uFEFF",
      "\u0085", "\u200C", "\u200D", "\u2060", "（", "）", "－", "．", "／", "＋", "：", "，",
      ...Array.from({ length: 6 }, (_, i) => String.fromCharCode(0x2010 + i)),
      "\u2212", "\u00B7", "\u2022", "(", ")",
    ];
    const mixed = (groups: string[]) => groups.reduce((text, group) => text + separators[random(separators.length)] + group);
    const formats = [
      () => mixed(["202", "555", `01${String(random(100)).padStart(2, "0")}`]),
      () => "+1" + mixed(["", "202", "555", "0100"]),
      () => `(${mixed(["202"])})${mixed(["", "555", "0101"])}`,
      () => `+1 (202)${mixed(["", "555", "0102"])}`,
      () => "+12025550103",
      () => "+" + mixed(["44", "20", "7946", "0000"]),
      () => "+" + mixed(["52", "55", "0000", "0000"]),
      () => mixed(["999", "000", "000", "0000"]),
    ];
    const extensions = ["x", "X", "ext", "ext.", "extension", "#", "(", "", "ｘ", "ｅｘｔ．", "ｅｘｔｅｎｓｉｏｎ", "＃"];
    const digitZeros = [0x30, 0xff10, 0x660, 0x6f0, 0x966, 0x9e6, 0xe50, 0x1d7ce];
    const mixScripts = (text: string) => text.replace(/[0-9]/g, (digit) =>
      String.fromCodePoint(digitZeros[random(digitZeros.length)] + Number(digit)));
    const protectedTokens = ["2026-11-23T10:30:00.123Z", "12345678901234567890"];
    const assertMasked = (output: unknown) => {
      if (typeof output === "string") {
        expect(output).toContain("***-***-");
        const unprotected = protectedTokens.reduce((text, token) => text.split(token).join(""), output).normalize("NFKC").replace(/\\(?:[tnrfv]|u000[bB])/g, " ");
        // Independent leak oracle: count digits across every contiguous run of
        // digits and allowed separators, including the visible mask tail.
        for (const run of unprotected.match(/[\p{Nd}\p{White_Space}\p{Zs}\p{Pd}\u200B-\u200D\u2060\uFEFF\u2212\u00B7\u2022.,():/+\[\]{}-]+/gu) ?? []) {
          expect(Array.from(run.matchAll(/\p{Nd}/gu)).length, output).toBeLessThan(7);
        }
      } else if (output && typeof output === "object") {
        for (const child of Object.values(output)) assertMasked(child);
      }
    };
    // Exercise every separator around extension markers as well as digit groups.
    for (const format of formats) for (const extension of extensions) {
      for (let length = 1; length <= 6; length++) for (const space of ["", separators[random(separators.length)]]) {
        const digits = Array.from({ length }, () => random(10)).join("");
        const suffix = extension === "(" ? `${space}(${digits})` :
          extension ? `${space}${extension}${space}${digits}` : "";
        const phone = mixScripts(format() + suffix);
        const sentence = `Synthetic call ${phone}; please respond.`;
        const json = JSON.stringify({ note: sentence, id: protectedTokens[1], createdAt: protectedTokens[0] });
        for (const input of [sentence, json]) {
          assertMasked(maskString(input));
          assertMasked(mask({ phone: input, note: input }));
          assertMasked(mask({ body: input, text: input, transcript: [input], turns: [{ text: input, nested: { note: input } }] }, "", true));
        }
      }
    }
  });

  it("rejects notification methods with ids and invalid request ids without dispatch", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const core = create();
    for (const id of ["notification", "", 0, -1, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER]) {
      for (const method of ["notifications/initialized", "notifications/custom"]) {
        expect(await core.handleMessage({ ...call("health"), method, id }))
          .toEqual({ jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid Request" } });
      }
    }
    for (const id of [null, undefined, false, {}, [], 1.5, -1.5, 1e-200, Number.MAX_SAFE_INTEGER + 1, Number.MIN_SAFE_INTEGER - 1, Infinity, -Infinity, NaN]) {
      for (const method of ["tools/call", "notifications/custom"]) {
        expect(await core.handleMessage({ ...call("health"), method, id }))
          .toEqual({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
      }
    }
    expect(await core.handleMessage(JSON.parse('{"jsonrpc":"2.0","id":1e400,"method":"tools/call","params":{"name":"voice_fleet_health"}}')))
      .toEqual({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
    expect(fetch).not.toHaveBeenCalled();
    for (const id of ["", "request", 0, -1, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER]) {
      const response = await core.handleMessage({ jsonrpc: "2.0", id, method: "ping" });
      expect(JSON.parse(JSON.stringify(response))).toEqual({ jsonrpc: "2.0", id, result: {} });
    }
  });

  for (const name of ["commit", "commit_call_live", "operator_commit_call"]) {
    it.each([undefined, 1000])(`${name} shares one total timeout across slow confirm and commit (timeoutMs=%s)`, async (timeoutMs) => {
      vi.useFakeTimers();
      const budget = timeoutMs ?? 30000;
      const signals: AbortSignal[] = [];
      const fetch = vi.spyOn(globalThis, "fetch").mockImplementation((_url, options) => new Promise((resolve, reject) => {
        const signal = options!.signal!;
        signals.push(signal);
        const timer = setTimeout(() => resolve(Response.json({ confirmToken: "a".repeat(64) })), budget * 0.6);
        signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
      }));
      const core = createVoiceFleetMcp({ baseUrl: "https://fleet.example.test", getToken: () => "synthetic", timeoutMs });
      const done = vi.fn();
      const pending = core.handleMessage(call(name, { id: "synthetic-approval" })).then((reply) => { done(reply); return reply; });
      await vi.advanceTimersByTimeAsync(budget * 0.6);
      expect(fetch.mock.calls.map(([url]) => String(url))).toEqual([
        "https://fleet.example.test/api/plugin/v1/contact_requests/synthetic-approval/confirm_token",
        `https://fleet.example.test/api/plugin/v1/${name === "commit" ? "commit_contact" : "commit_call_live"}`,
      ]);
      expect(signals[0]).toBe(signals[1]);
      await vi.advanceTimersByTimeAsync(budget * 0.4 - 1);
      expect(done).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(done).toHaveBeenCalledOnce();
      expect(await pending).toMatchObject({ result: { isError: true, content: [{ text: "Error: Fleet request failed" }] } });
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    });
  }

  it("returns at the deadline even if a slow confirm mock ignores abort, without a late commit", async () => {
    vi.useFakeTimers();
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve(Response.json({ confirmToken: "a".repeat(64) })), 150);
    }));
    const core = createVoiceFleetMcp({ baseUrl: "https://fleet.example.test", getToken: () => "synthetic", timeoutMs: 100 });
    const pending = core.handleMessage(call("commit", { id: "synthetic-approval" }));
    await vi.advanceTimersByTimeAsync(100);
    expect(await pending).toMatchObject({ result: { isError: true } });
    await vi.advanceTimersByTimeAsync(50);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("negotiates only supported protocol versions, preferring the latest otherwise", async () => {
    expect(SUPPORTED).toEqual(["2025-06-18", "2025-03-26", "2024-11-05"]);
    const core = create();
    for (const version of [...SUPPORTED, "2099-01-01", "", null, 123, undefined]) {
      const reply = await core.handleMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: version } });
      expect(reply).toMatchObject({ result: { protocolVersion: SUPPORTED.some((supported) => supported === version) ? version : SUPPORTED[0] } });
    }
    expect(await core.handleMessage({ jsonrpc: "2.0", id: 2, method: "initialize" })).toMatchObject({ result: { protocolVersion: SUPPORTED[0] } });
  });

  it("ignores client responses and notifications without dispatching tools", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const core = create();
    for (const message of [
      { jsonrpc: "2.0", id: 1, result: {} },
      { jsonrpc: "2.0", id: 2, result: null },
      { jsonrpc: "2.0", id: "error", error: { code: -32603, message: "Synthetic error" } },
      { jsonrpc: "2.0", method: "tools/call", params: { name: "voice_fleet_health" } },
    ]) expect(await core.handleMessage(message)).toBeNull();
    expect(await core.handleMessage({ jsonrpc: "2.0", id: 3 })).toMatchObject({ error: { code: -32600 } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects malformed client responses without dispatch", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const core = create();
    const invalid = [
      { jsonrpc: "2.0", id: 1 },
      { jsonrpc: "2.0", id: 1, result: null, error: { code: -32603, message: "Synthetic error" } },
      ...[undefined, null, true, {}, [], 1.5, 1e-200, Number.MAX_SAFE_INTEGER + 1, Infinity, -Infinity, NaN].flatMap((id) => [
        { jsonrpc: "2.0", id, result: null },
        { jsonrpc: "2.0", id, error: { code: -32603, message: "Synthetic error" } },
      ]),
      ...[undefined, null, false, "error", 1, [], {}, { code: -32603 }, { message: "Synthetic error" },
        { code: "-32603", message: "Synthetic error" }, { code: 1.5, message: "Synthetic error" },
        { code: Infinity, message: "Synthetic error" }, { code: NaN, message: "Synthetic error" },
        { code: -32603, message: 1 }].map((error) => ({ jsonrpc: "2.0", id: 1, error })),
    ];
    for (const message of invalid) expect(await core.handleMessage(message))
      .toEqual({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "Invalid Request" } });
    for (const id of ["", "response", 0, -1, Number.MAX_SAFE_INTEGER, Number.MIN_SAFE_INTEGER]) {
      for (const result of [null, false, 0, "", [], {}]) expect(await core.handleMessage({ jsonrpc: "2.0", id, result })).toBeNull();
      expect(await core.handleMessage({ jsonrpc: "2.0", id, error: { code: 0, message: "", data: null } })).toBeNull();
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("preserves full fleet JSON on non-operator tools as the original did", async () => {
    const data = { phone: "9095550113", name: "Synthetic Person", email: "synthetic@example.test", transcript: [{ text: "Synthetic transcript" }], purpose: "Synthetic purpose", body: "Synthetic body", recordingUrl: "https://example.test/recording" };
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json(data));
    const core = create();
    for (const message of [call("get_transcript", { sessionId: "s1" }), call("live_call_status", { sessionId: "s1" }), call("prepare_text", { phone: "9095550113", body: "Synthetic body" })]) {
      const reply = await core.handleMessage(message);
      expect(reply).toMatchObject({ result: { isError: false, content: [{ type: "text", text: JSON.stringify({ status: 200, ok: true, data }, null, 2) }] } });
    }
  });

  it("returns JSON-RPC validation errors and never sends invalid tool arguments", async () => {
    const fetch = vi.spyOn(globalThis, "fetch");
    const core = create();
    for (const value of [null, [], {}, { jsonrpc: "1.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: {}, method: "ping" }]) expect(await core.handleMessage(value)).toMatchObject({ error: { code: -32600 } });
    expect(await core.handleMessage({ jsonrpc: "2.0", id: 1, method: "ping", params: [] })).toMatchObject({ error: { code: -32602 } });
    for (const message of [call("commit"), call("commit_call_live", { approvalId: "synthetic" }), call("operator_inbound_get", { callSid: "../x" }), call("operator_prepare_call", { phone: "+19095550113", purpose: "x".repeat(4001) }), call("health", []), call("health", null)]) expect(await core.handleMessage(message)).toMatchObject({ result: { isError: true } });
    expect(await core.handleMessage(call("unknown"))).toMatchObject({ error: { code: -32602 } });
    expect(await core.handleMessage({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("does not disclose thrown credentials, upstream bodies, or non-JSON error pages", async () => {
    const fetch = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("Synthetic private body and bearer"));
    const core = create();
    const failed = await core.handleMessage(call("health"));
    expect(JSON.stringify(failed)).not.toContain("Synthetic private");
    expect(failed).toMatchObject({ result: { isError: true } });
    fetch.mockResolvedValueOnce(new Response("Synthetic private HTML", { status: 200 }));
    const nonJson = await core.handleMessage(call("health"));
    expect(nonJson).toMatchObject({ result: { isError: true } });
    expect(JSON.stringify(nonJson)).not.toContain("Synthetic private");
  });

  it.each(["health", "operator_inbound_get"])("reloads the stdio token file for each %s call and masks operator output", async (name) => {
    const directory = mkdtempSync(join(tmpdir(), "voice-fleet-mcp-"));
    const tokenFile = join(directory, "bot.token");
    const input = new PassThrough();
    const output = new PassThrough();
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({
      from: "+44 20 7946 0000", body: "Call +44-20-7946-0001 or +1 (909) 555-0113",
    }));
    const shell = startStdio(input, output, { VOICE_FLEET_TOKEN_FILE: tokenFile, VOICE_FLEET_BASE_URL: "http://127.0.0.1:54321/", VOICE_FLEET_TIMEOUT_MS: "1000" });
    try {
      for (const digit of ["b", "c"]) {
        const bearer = `si.${"a".repeat(32)}.${digit.repeat(64)}`;
        writeFileSync(tokenFile, bearer);
        const reply = once(output, "data");
        input.write(JSON.stringify(call(name, { callSid: "CA" + "a".repeat(32), includeContent: true })) + "\n");
        const [line] = await reply;
        const result = JSON.parse(line.toString()).result;
        expect(result.isError).toBe(false);
        if (name === "operator_inbound_get") expect(JSON.parse(result.content[0].text).data).toEqual({
          from: "***-***-0000", body: "Call ***-***-0001 or ***-***-0113",
        });
        const path = name === "health" ? "/health" : `/operator-line/inbound/CA${"a".repeat(32)}`;
        expect(fetch.mock.lastCall).toMatchObject([`http://127.0.0.1:54321/api/plugin/v1${path}`, { headers: { Authorization: `Bearer ${bearer}` } }]);
      }
    } finally {
      input.end();
      shell.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
