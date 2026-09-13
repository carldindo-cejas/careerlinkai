import { log } from '@/lib/logger';

/**
 * `WebSearchService` — Gate 3's source of passages (prompt-driven, 2026-09-05).
 *
 * ## Why this exists
 *
 * §30's pipeline has two sources, and measured on production both were empty for most questions:
 * `/admin/ai-insights` reported 0 of 202 programs covered, and even a fully synced corpus is
 * auto-generated catalog text that will never hold a tuition figure or an application deadline.
 * The honest refusal that follows is correct but it is not an answer, and a student who is told
 * "ask your counselor" to every question stops asking.
 *
 * ## Why a search API rather than the model's memory
 *
 * The tier below this one does use the model's memory, and it is labelled on screen because that
 * is all you can honestly do with it. This tier is different in kind: a search result is a
 * **citable passage**, so it goes through the same grounding contract a knowledge chunk does —
 * cite-or-refuse, the unsupported-claim check, the verifier — and the answer names the domain it
 * came from, which a student can go and check. That is the whole reason to spend a subrequest on
 * search rather than just letting the model talk.
 *
 * ## Why Serper, and what that costs
 *
 * Chosen by the project owner. It returns Google's organic results as titles, links and snippets —
 * **not** page content. That matters here: a Worker cannot fetch and parse five pages inside a
 * Free-plan invocation (50 subrequests, 10 ms CPU), so the snippet *is* the passage. The claim
 * check then measures the answer against snippets rather than full pages, which means a figure
 * that is on the page but not in the snippet gets rejected. That is the safe direction and it is
 * deliberate — this tier refuses more than it could, rather than asserting more than it can show.
 *
 * ## Failure posture
 *
 * Never throws, and returns `[]` for every reason it might not work: no key, a non-200, a timeout,
 * malformed JSON. `[]` is indistinguishable from "the web has nothing", and both mean the same
 * thing to the caller — fall through to the next gate. A search outage must not turn a chat turn
 * into a 500 while the student is looking at it.
 *
 * With no `SERPER_API_KEY` the service is inert before it can reach for the network, which is what
 * keeps the suite hermetic (deviation D9) — the same posture `EmailService` takes with
 * `RESEND_API_KEY`, and for the same reason.
 */

const SERPER_ENDPOINT = 'https://google.serper.dev/search';

/** Enough passages to answer from, few enough to keep the prompt inside the token budget. */
export const WEB_RESULTS_TOP_K = 5;

/**
 * Past this the turn is slower than a student will wait, and the gate below is free. Aborting is
 * better than a long wait ending in the same fallback.
 */
const SEARCH_TIMEOUT_MS = 4000;

/** A snippet longer than this is padding; the prompt budget is better spent on more results. */
const MAX_SNIPPET_CHARS = 400;

export interface WebResult {
  title: string;
  url: string;
  snippet: string;
  /** `usc.edu.ph` — what actually tells a student whether to trust the sentence above it. */
  domain: string;
}

export class WebSearchService {
  constructor(private readonly apiKey: string | undefined) {}

  /** True when a key is configured. The policy switch is checked separately, by the caller. */
  get configured(): boolean {
    return this.apiKey !== undefined && this.apiKey.trim() !== '';
  }

  /**
   * Search, or return nothing.
   *
   * `gl: 'ph'` and `hl: 'en'` are not cosmetic: every student on this platform is choosing a
   * Philippine college, and an unlocalised query for "BS Computer Science tuition" returns
   * American universities that are worse than no answer, because they are plausible.
   */
  async search(query: string): Promise<WebResult[]> {
    if (!this.configured) {
      return [];
    }

    const started = Date.now();

    try {
      const response = await fetch(SERPER_ENDPOINT, {
        method: 'POST',
        headers: {
          'X-API-KEY': this.apiKey!,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          q: query,
          num: WEB_RESULTS_TOP_K,
          gl: 'ph',
          hl: 'en',
        }),
        signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
      });

      if (!response.ok) {
        log('warn', 'web_search.failed', {
          pipeline: 'web_search',
          stage: 'search_failed',
          status: response.status,
          latency_ms: Date.now() - started,
        });

        return [];
      }

      const results = normalise(await response.json());

      log('info', 'web_search.completed', {
        pipeline: 'web_search',
        stage: 'search_completed',
        results: results.length,
        latency_ms: Date.now() - started,
      });

      return results;
    } catch (error) {
      // A timeout and a DNS failure are the same event to this caller: no passages.
      log('warn', 'web_search.error', {
        pipeline: 'web_search',
        stage: 'search_error',
        latency_ms: Date.now() - started,
        error: error instanceof Error ? error.message : String(error),
      });

      return [];
    }
  }
}

/**
 * Serper's payload, reduced to the four fields this system uses.
 *
 * Hand-narrowed rather than schema-parsed: the response is a third party's shape, every field is
 * treated as absent until proved otherwise, and anything that does not yield a usable title, URL
 * and snippet is dropped. A result with an empty snippet is worse than no result — it is a source
 * the model can cite and the claim check cannot measure anything against.
 *
 * `answerBox` is read first when present, because Google has already extracted the sentence that
 * answers the question and it is the highest-quality passage in the payload.
 */
function normalise(payload: unknown): WebResult[] {
  if (typeof payload !== 'object' || payload === null) {
    return [];
  }

  const body = payload as Record<string, unknown>;
  const results: WebResult[] = [];

  const answerBox = body.answerBox;

  if (typeof answerBox === 'object' && answerBox !== null) {
    const box = answerBox as Record<string, unknown>;
    const text = firstString(box.answer, box.snippet);
    const link = firstString(box.link);

    if (text !== null && link !== null) {
      const built = build(firstString(box.title) ?? domainOf(link) ?? 'Web result', link, text);

      if (built !== null) {
        results.push(built);
      }
    }
  }

  const organic = Array.isArray(body.organic) ? body.organic : [];

  for (const entry of organic) {
    if (typeof entry !== 'object' || entry === null) {
      continue;
    }

    const row = entry as Record<string, unknown>;
    const built = build(firstString(row.title), firstString(row.link), firstString(row.snippet));

    if (built !== null && !results.some((existing) => existing.url === built.url)) {
      results.push(built);
    }

    if (results.length >= WEB_RESULTS_TOP_K) {
      break;
    }
  }

  return results.slice(0, WEB_RESULTS_TOP_K);
}

function build(title: string | null, url: string | null, snippet: string | null): WebResult | null {
  if (title === null || url === null || snippet === null) {
    return null;
  }

  const domain = domainOf(url);

  if (domain === null) {
    return null;
  }

  return {
    title: title.slice(0, 200),
    url,
    snippet: snippet.slice(0, MAX_SNIPPET_CHARS),
    domain,
  };
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') {
      return value.trim();
    }
  }

  return null;
}

/** `https://www.usc.edu.ph/admissions` becomes `usc.edu.ph`. Null for anything not an http(s) URL. */
function domainOf(url: string): string | null {
  try {
    const parsed = new URL(url);

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return null;
    }

    return parsed.hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}
