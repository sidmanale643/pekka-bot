import { describe, expect, it, vi } from "vitest";
import { executeToolCall } from "../agent/execute-tool-call.ts";
import { FakeComputer } from "../computer/fake-computer.ts";
import { defaultTools } from "./index.ts";
import { createWebScrapeTool } from "./web-scrape.ts";
import { LOCAL_USER } from "../database/database.ts";

const context = { computer: new FakeComputer(), userId: LOCAL_USER };

describe("web_scrape", () => {
  it("registers the tool and fetches a URL without losing its query parameters", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response("# Example"));
    const tool = createWebScrapeTool({ SCRAPERAPI_API_KEY: "secret" }, request);
    const url = "https://example.com/?q=a&next=b%20c";
    const result = await tool.run({ url }, context);
    const [endpoint, options] = request.mock.calls[0]!;
    const parsed = new URL(String(endpoint));
    expect(parsed.origin).toBe("https://api.scraperapi.com");
    expect(parsed.searchParams.get("url")).toBe(url);
    expect(parsed.searchParams.get("output_format")).toBe("markdown");
    expect(parsed.searchParams.get("render")).toBe("false");
    expect(options?.headers).toEqual({ "x-sapi-api_key": "secret" });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(result).toContain("# Example");
    expect(defaultTools.some((entry) => entry.name === tool.name)).toBe(true);
  });

  it("requests rendered HTML without sending an unsupported html output parameter and limits output", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(new Response("x".repeat(25_000)));
    const tool = createWebScrapeTool({ SCRAPERAPI_API_KEY: "secret" }, request);
    const result = await tool.run({ url: "https://example.com", render: true, output_format: "html" }, context);
    const endpoint = new URL(String(request.mock.calls[0]![0]));
    expect(endpoint.searchParams.has("output_format")).toBe(false);
    expect(endpoint.searchParams.get("render")).toBe("true");
    expect(result).toContain("characters omitted]");
    expect(result.length).toBeLessThan(20_100);
  });

  it("reports missing configuration and rejects non-HTTP URLs without making requests", async () => {
    const request = vi.fn<typeof fetch>();
    const tool = createWebScrapeTool({}, request);
    await expect(tool.run({ url: "https://example.com" }, context)).rejects.toThrow("SCRAPERAPI_API_KEY");
    const result = await executeToolCall({ id: "scrape", type: "function", function: {
      name: tool.name, arguments: JSON.stringify({ url: "file:///etc/passwd" }),
    } }, [tool], context);
    expect(result.isError).toBe(true);
    expect(request).not.toHaveBeenCalled();
  });

  it("reports provider errors without returning the response body or leaking credentials", async () => {
    const request = vi.fn<typeof fetch>().mockResolvedValueOnce(new Response("private details", { status: 429 }))
      .mockRejectedValueOnce(new Error("request secret failed"));
    const tool = createWebScrapeTool({ SCRAPERAPI_API_KEY: "secret" }, request);
    await expect(tool.run({ url: "https://example.com" }, context)).rejects.toThrow("HTTP 429");
    await expect(tool.run({ url: "https://example.com" }, context)).rejects.toThrow("request [redacted] failed");
  });
});
