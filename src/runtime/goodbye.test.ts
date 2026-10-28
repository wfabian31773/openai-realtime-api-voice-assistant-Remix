import { describe, expect, it } from "vitest";
import { callerConclusion, isAgentSignOff } from "./goodbye";

describe("conservative goodbye matcher", () => {
  it.each([
    "Goodbye!", "Bye.", "Bye bye", "That's all.", "Thank you, bye!",
    "Okay, thanks. Have a good day.", "Have a good day!", "Take care.",
    "Adiós.", "Adios!", "Hasta luego", "Chao", "Chau!", "Gracias, adiós.",
    "Que tenga un buen día.", "Eso es todo, gracias.",
  ])("recognizes a whole farewell: %s", (text) => {
    expect(callerConclusion(text, "")).toBe("farewell");
  });

  it.each([
    "", "No", "Thanks", "Thank you", "That's it", "Gracias", "No gracias",
    "Bye the way I need an appointment", "By the way I need an appointment",
    "Before I say goodbye, can you check something?", "Goodbye, but I need help",
    "Thank you, bye, can you send that?", "That's all I know about it",
    "Have a good day appointment available?", "I said goodbye yesterday",
    "Antes de decir adiós, necesito ayuda", "Gracias, necesito una cita",
    "Hasta luego, pero necesito otra cosa", "No, I need to change something",
    "Do not say goodbye", "Thanks for nothing", "That's all?",
  ])("rejects requests, mentions and ambiguous acknowledgements: %s", (text) => {
    expect(callerConclusion(text, "")).toBeNull();
  });

  it.each(["No.", "No, thank you.", "That's it.", "Thanks!", "Thank you.", "Nothing else."])(
    "accepts a done answer only after a closing question: %s", (text) => {
      expect(callerConclusion(text, "Is there anything else I can help you with?")).toBe("done");
      expect(callerConclusion(text, "What is your callback number?")).toBeNull();
    },
  );

  it.each(["No.", "No gracias.", "Nada más.", "Gracias."])(
    "accepts Spanish done answers to a closing question: %s", (text) => {
      expect(callerConclusion(text, "¿Hay algo más en que pueda ayudarle?")).toBe("done");
    },
  );

  it.each(["Yes.", "Yeah.", "Yes, thanks.", "Okay.", "Vale.", "Sí.", "Sí, gracias.", "No, yes."])(
    "does not mistake an affirmative or non-answer for being done: %s", (text) => {
      expect(callerConclusion(text, "Anything else?")).toBeNull();
      expect(callerConclusion(text, "¿Algo más?")).toBeNull();
    },
  );

  it.each(["Goodbye.", "You're welcome. Have a good day!", "Take care.", "Gracias por llamar. Hasta luego."])(
    "recognizes a completed agent sign-off: %s", (text) => expect(isAgentSignOff(text)).toBe(true),
  );

  it.each(["Anything else?", "Have a good day, but first what is your number?", "Before I say goodbye, I need your name.", "Take care of the paperwork."])(
    "rejects agent questions and farewell mentions: %s", (text) => expect(isAgentSignOff(text)).toBe(false),
  );
});

describe("goodbye matcher cost (Codex P2, #396)", () => {
  it("rejects long repeated farewells quickly instead of backtracking", () => {
    const started = Date.now();
    const text = "bye ".repeat(5_000) + "wait";
    expect(callerConclusion(text, "")).toBeNull();
    expect(isAgentSignOff(text)).toBe(false);
    expect(callerConclusion("bye ".repeat(20) + "wait", "")).toBeNull();
    expect(Date.now() - started).toBeLessThan(200);
  });
});
