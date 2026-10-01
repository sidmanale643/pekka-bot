import { describe, expect, it } from "vitest";
import { isPekkaCallback, loadAuthConfig } from "./auth.ts";

const google = { GOOGLE_CLIENT_ID: "client", GOOGLE_CLIENT_SECRET: "secret" };

describe("sign-in configuration", () => {
  it("is off without PEKKA_URL", () => {
    expect(loadAuthConfig({ ...google, PEKKA_ALLOWED_EMAILS: "a@example.com" })).toBeUndefined();
  });

  it("requires HTTPS, an origin-only URL, Google credentials and an allowlist", () => {
    const env = { ...google, PEKKA_URL: "https://pekka.example.com", PEKKA_ALLOWED_EMAILS: "a@example.com" };
    expect(loadAuthConfig(env)).toMatchObject({
      origin: "https://pekka.example.com", host: "pekka.example.com", secure: true,
      redirectUri: "https://pekka.example.com/api/auth/google/callback",
    });
    expect(loadAuthConfig({ ...env, PEKKA_URL: "http://127.0.0.1:3000" })).toMatchObject({ secure: false });
    expect(() => loadAuthConfig({ ...env, PEKKA_URL: "http://pekka.example.com" })).toThrow("https://");
    expect(() => loadAuthConfig({ ...env, PEKKA_URL: "https://pekka.example.com/app" })).toThrow("origin only");
    expect(() => loadAuthConfig({ ...env, GOOGLE_CLIENT_SECRET: "" })).toThrow("GOOGLE_CLIENT_SECRET");
    expect(() => loadAuthConfig({ ...env, PEKKA_ALLOWED_EMAILS: "" })).toThrow("PEKKA_ALLOWED_EMAILS");
    expect(() => loadAuthConfig({ ...env, PEKKA_ALLOWED_EMAILS: "not-an-email" })).toThrow("invalid entry");
  });

  it("admits listed addresses, listed domains and the owner, ignoring case", () => {
    const config = loadAuthConfig({
      ...google, PEKKA_URL: "https://pekka.example.com", PEKKA_ALLOWED_EMAILS: " Alice@Example.com, @team.example ", PEKKA_OWNER_EMAIL: "owner@home.example",
    })!;
    expect(config.ownerEmail).toBe("owner@home.example");
    expect(["alice@example.com", "ALICE@example.com", "bob@team.example", "owner@home.example"].map(config.allowed)).toEqual([true, true, true, true]);
    expect(["bob@example.com", "bob@sub.team.example", "team.example@evil.example"].map(config.allowed)).toEqual([false, false, false]);
  });

  it("accepts plugin callbacks on localhost or at PEKKA_URL only", () => {
    const path = "/api/plugins/gmail/callback";
    const env = { PEKKA_URL: "https://pekka.example.com" };
    expect(isPekkaCallback(`http://127.0.0.1:3000${path}`, path, {})).toBe(true);
    expect(isPekkaCallback(`https://pekka.example.com${path}`, path, env)).toBe(true);
    expect(isPekkaCallback(`https://pekka.example.com${path}`, path, {})).toBe(false);
    expect(isPekkaCallback(`https://evil.example${path}`, path, env)).toBe(false);
    expect(isPekkaCallback(`https://pekka.example.com${path}?next=1`, path, env)).toBe(false);
    expect(isPekkaCallback("https://pekka.example.com/other", path, env)).toBe(false);
  });
});
