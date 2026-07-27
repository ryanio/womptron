/**
 * Fetching and parsing the Voxels womps feed.
 *
 * This module deliberately knows nothing about X. The API-shape checker
 * (src/check-api.ts) imports it without needing credentials, and the parser it
 * validates against is the exact one the bot posts from, so the check cannot
 * drift away from production behaviour.
 *
 * The API has changed shape under us before, so everything here is written to
 * fail loudly rather than quietly return nothing. See the header of
 * parseAuthor for the shapes we accept.
 */

import { logger } from './logger';
import { shortAddr, timeout, truncate } from './util';

export const WOMPS_API_URL = 'https://www.voxels.com/api/womps.json';

/**
 * Keys the current API returns on every womp. Used by the shape checker to
 * report added and removed fields, and by nothing else: the parser itself
 * only insists on the handful of fields it actually reads, so a new key
 * appearing upstream never stops the bot from posting.
 */
export const EXPECTED_WOMP_KEYS = [
  'author',
  'content',
  'coords',
  'created_at',
  'id',
  'image_supplied',
  'image_url',
  'parcel_address',
  'parcel_id',
  'parcel_island',
  'parcel_name',
  'updated_at',
] as const;

/**
 * The author object the API has returned since roughly mid-2026. `name` is the
 * display name and is frequently null; `owner` is the wallet address.
 */
export interface ApiAuthor {
  created_at?: string | null;
  id?: string | null;
  name?: string | null;
  owner?: string | null;
}

/**
 * A womp as the Voxels API returns it. Everything is optional because this
 * describes untrusted input: the parser decides what is actually required.
 * `author` is typed as the union of the current and the legacy shape.
 */
export interface ApiWomp {
  author?: ApiAuthor | string | null;
  /** Legacy only. Removed from the API; kept so a rollback still parses. */
  author_name?: string | null;
  content?: string | null;
  coords?: string | null;
  created_at?: string | null;
  id?: number | null;
  image_supplied?: boolean | null;
  image_url?: string | null;
  parcel_address?: string | null;
  parcel_id?: number | null;
  parcel_island?: string | null;
  parcel_name?: string | null;
  updated_at?: string | null;
}

/** A womp after parsing, ready to be turned into post text. */
export interface Womp {
  author: string;
  content: string;
  coords: string;
  createdAt: number;
  id: number;
  imgSrc: string;
  location: string;
  playUrl: string;
}

/** One womp that would not parse, kept so the checker can report on it. */
export interface WompParseFailure {
  id: number | null;
  reason: string;
}

export interface WompsBatch {
  /** Every womp in the response that parsed, newest id first. */
  womps: Womp[];
  /** Womps in the response that did not parse. */
  failures: WompParseFailure[];
  /** Highest id in the response, or null if the response was empty. */
  newestId: number | null;
  /** How many entries the response contained, parsed or not. */
  total: number;
}

/**
 * Thrown when the response is unusable as a whole, as opposed to one bad womp.
 * The caller turns this into a non-zero exit so the run goes red instead of
 * looking like a quiet "no new womps".
 */
export class WompsShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WompsShapeError';
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asTrimmedString = (value: unknown): string =>
  typeof value === 'string' ? value.trim() : '';

/**
 * Resolves the display name for a womp, across both API shapes.
 *
 * Current (confirmed live 2026-07-27 against womp 81179): `author` is an
 * object, `{ id, name, owner, created_at }`. The display name is `author.name`
 * and is null more often than not; the wallet is `author.owner`. There is no
 * top-level `author_name` any more.
 *
 * Legacy (what the bot was written against): `author` is the wallet address as
 * a string and the display name is the top-level `author_name`. Still accepted
 * so a rollback on the Voxels side does not break us a second time.
 */
const parseAuthor = (raw: Record<string, unknown>): string => {
  const { author } = raw;

  if (isRecord(author)) {
    const name = asTrimmedString(author.name);
    if (name) {
      return name;
    }
    const owner = asTrimmedString(author.owner);
    if (owner) {
      return shortAddr(owner);
    }
    throw new Error('author object has neither a name nor an owner');
  }

  if (typeof author === 'string' && author.trim()) {
    const legacyName = asTrimmedString(raw.author_name);
    return legacyName || shortAddr(author.trim());
  }

  throw new Error(
    `author is neither an object nor a non-empty string (got ${typeof author})`
  );
};

// Strips unsolicited @mentions by dropping the @ and keeping the word, so the
// bot never pulls someone into a thread because of what a womp caption said.
const MENTION_PATTERN =
  /(^|\s|\n|\^|\(|\)|\{|\}|\[|\]|\+|-|\\|\/|\.|,|\|||<|>|\?|'|"|:|;)@(\w*)/g;

const deMention = (text: string) => text.replace(MENTION_PATTERN, '$1$2');

/**
 * Turns one raw entry into a Womp, or throws with a reason naming the field
 * that is wrong. Callers catch per womp so a single bad entry is skipped
 * rather than taking down the batch.
 */
export const parseWomp = (raw: unknown): Womp => {
  if (!isRecord(raw)) {
    throw new Error(`womp is not an object (got ${typeof raw})`);
  }

  if (typeof raw.id !== 'number' || !Number.isFinite(raw.id)) {
    throw new Error(`id is missing or not a number (got ${String(raw.id)})`);
  }
  const id = raw.id;

  const imgSrc = asTrimmedString(raw.image_url);
  if (!imgSrc) {
    throw new Error(
      'image_url is missing or empty, so there is nothing to post'
    );
  }

  const createdAt = Date.parse(asTrimmedString(raw.created_at));
  if (Number.isNaN(createdAt)) {
    throw new Error(
      `created_at is missing or unparseable (got ${String(raw.created_at)})`
    );
  }

  const author = parseAuthor(raw);
  const coords = asTrimmedString(raw.coords);

  // parcel_name is null on plenty of real parcels while parcel_address is set,
  // so the address is the fallback and an empty location is legitimate.
  const location = deMention(
    asTrimmedString(raw.parcel_name) || asTrimmedString(raw.parcel_address)
  );
  const content = truncate(deMention(asTrimmedString(raw.content)).trim());

  return {
    author,
    content,
    coords,
    createdAt,
    id,
    imgSrc,
    location,
    playUrl: `https://voxels.com/play?coords=${coords}`,
  };
};

/**
 * Validates the envelope and parses every entry.
 *
 * Throws WompsShapeError when the payload is not a womps response at all, or
 * when every entry fails to parse. The second case is the shape-change alarm:
 * one bad womp is a bad womp, all of them is the API having moved.
 */
export const parseWompsPayload = (payload: unknown): WompsBatch => {
  if (!isRecord(payload)) {
    throw new WompsShapeError(
      `response body is not an object (got ${typeof payload})`
    );
  }

  if (!Array.isArray(payload.womps)) {
    throw new WompsShapeError(
      `response has no "womps" array (top-level keys: ${Object.keys(payload).join(', ') || 'none'})`
    );
  }

  const entries = payload.womps;
  const womps: Womp[] = [];
  const failures: WompParseFailure[] = [];

  for (const entry of entries) {
    try {
      womps.push(parseWomp(entry));
    } catch (error) {
      const id =
        isRecord(entry) && typeof entry.id === 'number' ? entry.id : null;
      failures.push({
        id,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (entries.length > 0 && womps.length === 0) {
    throw new WompsShapeError(
      `all ${entries.length} womps in the response failed to parse, which means the API shape changed. First reason: ${failures[0]?.reason ?? 'unknown'}`
    );
  }

  const newestId = womps.reduce<number | null>(
    (max, womp) => (max === null || womp.id > max ? womp.id : max),
    null
  );

  return {
    womps: [...womps].sort((a, b) => b.id - a.id),
    failures,
    newestId,
    total: entries.length,
  };
};

const FETCH_ATTEMPTS = 3;
const FETCH_RETRY_BASE_MS = 1000;

/**
 * Fetches the raw feed. Retries a couple of times on a network blip or a 5xx,
 * because a scheduled bot going red over one flaky second is noise. A failure
 * that survives the retries throws, and the run exits non-zero: a run that
 * could not reach the API must never be reported as "no new womps".
 */
export const fetchWompsPayload = async (
  url = WOMPS_API_URL
): Promise<unknown> => {
  let lastError: Error = new Error('no fetch attempted');

  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt += 1) {
    try {
      // Cache-buster: the feed sits behind a CDN that will happily serve a
      // stale page to a bot polling on a schedule.
      const response = await fetch(`${url}?${Date.now()}`);

      if (!response.ok) {
        const body = await response.text().catch(() => '<unreadable>');
        throw new Error(
          `HTTP ${response.status} ${response.statusText}: ${truncate(body, 200)}`
        );
      }

      return await response.json();
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      if (attempt < FETCH_ATTEMPTS) {
        logger.warn(
          `Womps fetch attempt ${attempt}/${FETCH_ATTEMPTS} failed: ${lastError.message}. Retrying.`
        );
        await timeout(FETCH_RETRY_BASE_MS * attempt);
      }
    }
  }

  throw new Error(
    `Could not fetch the womps feed after ${FETCH_ATTEMPTS} attempts: ${lastError.message}`
  );
};

/**
 * Fetch, then parse. Throws on anything that makes the response unusable;
 * logs and reports individual womps that would not parse.
 */
export const getWomps = async (url = WOMPS_API_URL): Promise<WompsBatch> => {
  const payload = await fetchWompsPayload(url);
  const batch = parseWompsPayload(payload);

  if (batch.failures.length > 0) {
    logger.warn(
      `Skipped ${batch.failures.length} of ${batch.total} womps that would not parse. Run "yarn check:api" to see whether the API shape moved.`
    );
    for (const failure of batch.failures) {
      logger.warn(`  womp ${failure.id ?? '<no id>'}: ${failure.reason}`);
    }
  }

  if (batch.total === 0) {
    logger.warn('The womps feed returned zero entries.');
  }

  return batch;
};
