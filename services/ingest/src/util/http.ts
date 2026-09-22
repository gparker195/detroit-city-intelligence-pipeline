/**
 * Minimal HTTP layer shared by the ArcGIS client and the item resolver.
 *
 * - Identifying User-Agent on every request (AGENTS.md: read official sites with an identifying UA).
 * - Global rate limit: never more than `maxRequestsPerSecond` request starts per second (default 2).
 * - Retries with exponential backoff on HTTP 429 / 5xx, on network errors, and on ArcGIS
 *   "200 OK with {error:{code:5xx|429}}" bodies, which ArcGIS Online emits under load.
 *
 * Everything time-related is injectable so tests never sleep and never touch the network.
 */

export const USER_AGENT = 'DetroitCityIntelligence/0.1 (+https://github.com/gparker195/detroit-city-intelligence-pipeline)';

export type FetchLike = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
) => Promise<{
  status: number;
  ok: boolean;
  text(): Promise<string>;
}>;

export interface HttpOptions {
  fetchImpl?: FetchLike;
  userAgent?: string;
  /** Hard ceiling on request starts per second. Default 2. */
  maxRequestsPerSecond?: number;
  /** Total attempts per request (1 = no retry). Default 5. */
  maxAttempts?: number;
  /** First backoff delay in ms; doubles each attempt. Default 1000. */
  baseBackoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  log?: (message: string) => void;
}

export class HttpError extends Error {
  readonly status: number;
  readonly url: string;
  readonly body: string;
  constructor(status: number, url: string, body: string) {
    super(`HTTP ${status} from ${url}: ${body.slice(0, 200)}`);
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

export interface ArcgisErrorBody {
  error?: { code?: number; message?: string; details?: string[] };
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class HttpClient {
  private readonly fetchImpl: FetchLike;
  private readonly userAgent: string;
  private readonly minIntervalMs: number;
  private readonly maxAttempts: number;
  private readonly baseBackoffMs: number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly log: (message: string) => void;
  private nextAllowedStart = 0;
  /** Serialises the rate-limit gate so concurrent callers cannot both pass in the same slot. */
  private gate: Promise<void> = Promise.resolve();
  requestCount = 0;

  constructor(options: HttpOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? ((url, init) => globalThis.fetch(url, init));
    this.userAgent = options.userAgent ?? USER_AGENT;
    this.minIntervalMs = Math.ceil(1000 / (options.maxRequestsPerSecond ?? 2));
    this.maxAttempts = options.maxAttempts ?? 5;
    this.baseBackoffMs = options.baseBackoffMs ?? 1000;
    this.sleep = options.sleep ?? defaultSleep;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? (() => {});
  }

  /** Waits until the next request start slot, honouring the requests-per-second ceiling. */
  private async acquireSlot(): Promise<void> {
    const previous = this.gate;
    let release!: () => void;
    this.gate = new Promise<void>((resolve) => (release = resolve));
    await previous;
    try {
      const wait = this.nextAllowedStart - this.now();
      if (wait > 0) await this.sleep(wait);
      this.nextAllowedStart = Math.max(this.now(), this.nextAllowedStart) + this.minIntervalMs;
    } finally {
      release();
    }
  }

  /** GET a JSON document, with rate limiting and retries. */
  async getJson<T>(url: string): Promise<T> {
    return this.requestJson<T>(url, null);
  }

  /**
   * POST form-encoded parameters and read a JSON document. ArcGIS accepts every query
   * parameter in a form body, which is how large polygon filters avoid URL length limits.
   */
  async postJson<T>(url: string, params: Record<string, string | number | boolean | undefined>): Promise<T> {
    const body = new URLSearchParams();
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined) body.set(key, String(value));
    }
    return this.requestJson<T>(url, body.toString());
  }

  private async requestJson<T>(url: string, formBody: string | null): Promise<T> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      await this.acquireSlot();
      this.requestCount++;
      try {
        const response = await this.fetchImpl(url, {
          method: formBody === null ? 'GET' : 'POST',
          headers: {
            'User-Agent': this.userAgent,
            Accept: 'application/json',
            ...(formBody === null ? {} : { 'Content-Type': 'application/x-www-form-urlencoded' }),
          },
          ...(formBody === null ? {} : { body: formBody }),
        });
        const body = await response.text();
        if (response.status === 429 || response.status >= 500) {
          throw new HttpError(response.status, url, body);
        }
        if (!response.ok) {
          // 4xx other than 429 is not retryable.
          throw new HttpError(response.status, url, body);
        }
        let parsed: T & ArcgisErrorBody;
        try {
          parsed = JSON.parse(body) as T & ArcgisErrorBody;
        } catch {
          throw new HttpError(response.status, url, `non-JSON body: ${body.slice(0, 120)}`);
        }
        const code = parsed?.error?.code;
        if (typeof code === 'number') {
          if (code === 429 || code >= 500) throw new HttpError(code, url, body);
          throw new Error(`ArcGIS error ${code} from ${url}: ${parsed.error?.message ?? ''}`);
        }
        return parsed;
      } catch (error) {
        lastError = error;
        const retryable =
          (error instanceof HttpError && (error.status === 429 || error.status >= 500)) ||
          (!(error instanceof HttpError) && !(error instanceof Error && error.message.startsWith('ArcGIS error')));
        if (!retryable || attempt === this.maxAttempts) throw error;
        const delay = this.baseBackoffMs * 2 ** (attempt - 1);
        this.log(`retry ${attempt}/${this.maxAttempts - 1} after ${delay}ms: ${(error as Error).message}`);
        await this.sleep(delay);
      }
    }
    throw lastError;
  }
}

export function buildUrl(base: string, params: Record<string, string | number | boolean | undefined>): string {
  const url = new URL(base);
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined) continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}
