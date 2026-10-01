import { z } from "zod";
import { defineTool, limitOutput } from "./tool.ts";

const SearchResultSchema = z.object({
  title: z.string(),
  url: z.string(),
});

const TavilyResponseSchema = z.object({
  results: z.array(SearchResultSchema.extend({
    content: z.string().optional(),
    published_date: z.string().nullish(),
  })),
});

const ExaResponseSchema = z.object({
  results: z.array(SearchResultSchema.extend({
    highlights: z.array(z.string()).optional(),
    publishedDate: z.string().nullish(),
  })),
});

interface SearchResult {
  title: string;
  url: string;
  content?: string;
  publishedDate?: string | null;
}

export function createWebSearchTool(env: NodeJS.ProcessEnv = process.env, request: typeof fetch = fetch) {
  return defineTool({
    name: "web_search",
    permission: { effect: "read" },
    description: "Search the live web for current facts or sources. Returns titles, URLs, snippets, and available publication dates. Uses Tavily first and Exa if needed. Results are leads to assess, not verified facts.",
    input: z.object({
      query: z.string().trim().min(1).describe("Specific search query or question; include names and dates when useful."),
      max_results: z.number().int().min(1).max(10).optional().describe("Number of results to request, from 1 to 10. Defaults to 5."),
    }),
    async run({ query, max_results }) {
      const count = max_results ?? 5;
      const failures: string[] = [];

      if (env.TAVILY_API_KEY) {
        try {
          const response = await request("https://api.tavily.com/search", {
            method: "POST",
            headers: {
              Authorization: `Bearer ${env.TAVILY_API_KEY}`,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ query, max_results: count, search_depth: "basic" }),
            signal: AbortSignal.timeout(15_000),
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const parsed = TavilyResponseSchema.parse(await response.json());
          if (parsed.results.length > 0) {
            return formatResults("Tavily", parsed.results.map((result) => ({
              title: result.title,
              url: result.url,
              content: result.content,
              publishedDate: result.published_date,
            })));
          }
          failures.push("Tavily returned no results");
        } catch (error) {
          failures.push(`Tavily: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (env.EXA_API_KEY) {
        try {
          const response = await request("https://api.exa.ai/search", {
            method: "POST",
            headers: {
              "x-api-key": env.EXA_API_KEY,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ query, numResults: count, type: "auto", contents: { highlights: true } }),
            signal: AbortSignal.timeout(15_000),
          });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const parsed = ExaResponseSchema.parse(await response.json());
          if (parsed.results.length > 0) {
            return formatResults("Exa", parsed.results.map((result) => ({
              title: result.title,
              url: result.url,
              content: result.highlights?.join(" "),
              publishedDate: result.publishedDate,
            })));
          }
          failures.push("Exa returned no results");
        } catch (error) {
          failures.push(`Exa: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      if (!env.TAVILY_API_KEY && !env.EXA_API_KEY) {
        throw new Error("Web search needs TAVILY_API_KEY or EXA_API_KEY. See .env.example.");
      }
      throw new Error(`Web search failed: ${failures.join("; ")}`);
    },
  });
}

function formatResults(provider: string, results: SearchResult[]): string {
  return limitOutput(`${provider} search results:\n${results.map((result, index) => [
    `${index + 1}. ${result.title}`,
    result.url,
    result.publishedDate ? `Published: ${result.publishedDate}` : "",
    result.content ? result.content.slice(0, 1_500) : "",
  ].filter(Boolean).join("\n")).join("\n\n")}`);
}

export const webSearch = createWebSearchTool();
