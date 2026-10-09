import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";
import { localServer, setEnvValues } from "./env-file.js";

describe("setEnvValues", () => {
  it("replaces assignments in place, appends new ones and keeps everything else", () => {
    const text = "# Model\nOPENROUTER_API_KEY=old\n\nexport DAYTONA_API_KEY=old\nTAVILY_API_KEY=keep\n";
    const updated = setEnvValues(text, { OPENROUTER_API_KEY: "new", DAYTONA_API_KEY: "dt", PEKKA_PLUGIN_KEY: "abc" });
    expect(updated).toBe("# Model\nOPENROUTER_API_KEY=new\n\nDAYTONA_API_KEY=dt\nTAVILY_API_KEY=keep\nPEKKA_PLUGIN_KEY=abc\n");
  });

  it("starts a file from nothing", () => {
    expect(setEnvValues("", { A: "1" })).toBe("A=1\n");
  });

  it("quotes values that parseEnv would otherwise cut short", () => {
    for (const value of ["has # hash", "it's", 'say "hi"', "plain-token_123.4:5/6@7+8=9,0"]) {
      expect(parseEnv(setEnvValues("", { KEY: value })).KEY).toBe(value);
    }
  });

  it("does not match a key that only starts the same way", () => {
    expect(setEnvValues("PEKKA_URL_EXTRA=1\n", { PEKKA_URL: "x" })).toBe("PEKKA_URL_EXTRA=1\nPEKKA_URL=x\n");
  });
});

describe("localServer", () => {
  it("defaults to port 3000 on 127.0.0.1, like pnpm api", () => {
    expect(localServer("")).toEqual({ origin: "http://127.0.0.1:3000", port: 3000 });
    expect(localServer("PEKKA_API_PORT=3007")).toEqual({ origin: "http://127.0.0.1:3007", port: 3007 });
  });

  it("opens PEKKA_URL when it is an address on this Mac", () => {
    expect(localServer("PEKKA_URL=http://localhost:3000")).toEqual({ origin: "http://localhost:3000", port: 3000 });
    expect(localServer("PEKKA_URL=https://pekka.example.com")).toEqual({ origin: "http://127.0.0.1:3000", port: 3000 });
  });

  it("rejects a port that is not a port", () => {
    expect(() => localServer("PEKKA_API_PORT=http")).toThrow("PEKKA_API_PORT");
  });
});
