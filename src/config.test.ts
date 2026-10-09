import { expect, it } from "vitest";
import { loadConfig } from "./config.ts";

it("needs no keys: runs then use a Docker sandbox and the user's own model key", () => {
  expect(loadConfig({})).toEqual({
    openRouterApiKey: undefined,
    daytonaApiKey: undefined,
    model: "deepseek/deepseek-v4.1-flash",
    sandboxName: "pekka-computer",
    dockerImage: "python:3.13-bookworm",
    maxSteps: 30,
    contextWindow: undefined,
  });
});

it("treats an empty key like a missing one", () => {
  expect(loadConfig({ OPENROUTER_API_KEY: " ", DAYTONA_API_KEY: "" })).toMatchObject({ openRouterApiKey: undefined, daytonaApiKey: undefined });
  expect(loadConfig({ OPENROUTER_API_KEY: "sk-or", DAYTONA_API_KEY: "dt" })).toMatchObject({ openRouterApiKey: "sk-or", daytonaApiKey: "dt" });
});

it("still rejects settings it can't use", () => {
  expect(() => loadConfig({ PEKKA_MAX_STEPS: "lots" })).toThrow("PEKKA_MAX_STEPS");
});
