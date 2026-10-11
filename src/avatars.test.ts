import { expect, it } from "vitest";
import { BASE_PEKKA } from "./avatars.ts";

it("describes the same base Pekka the web app draws", async () => {
  const { PEKKA } = await import(new URL("./web/pekka-renderer.js", import.meta.url).href);
  const { kind: _kind, ...look } = BASE_PEKKA;
  expect(look).toEqual(PEKKA);
});
