/**
 * Re-validates the live Voxels womps feed against the parser the bot posts
 * from, and against the fixture captured in test/fixtures/womps-current.json.
 *
 *   yarn check:api              report on the live shape, exit non-zero if it moved
 *   yarn check:api --refresh    same, then rewrite the fixture from the live feed
 *
 * The feed has changed under us before (author went from a wallet string plus
 * a top-level author_name, to an object with name and owner) and the bot
 * silently posted nothing for as long as it took someone to notice. This
 * script exists so the next change takes one command to see and one command to
 * capture, rather than an evening of guessing.
 *
 * It deliberately imports the real parser rather than describing the shape a
 * second time. A check that has its own idea of the schema drifts away from
 * what the bot actually does, and then lies.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  EXPECTED_WOMP_KEYS,
  fetchWompsPayload,
  parseWomp,
  parseWompsPayload,
  WOMPS_API_URL,
} from './womps';

const FIXTURE_PATH = join(
  __dirname,
  '..',
  'test',
  'fixtures',
  'womps-current.json'
);

/** How many womps the refreshed fixture keeps. Small enough to read in a diff. */
const FIXTURE_SIZE = 5;

const out = (line = '') => process.stdout.write(`${line}\n`);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const keysOf = (entries: unknown[]) => {
  const keys = new Set<string>();
  for (const entry of entries) {
    if (isRecord(entry)) {
      for (const key of Object.keys(entry)) {
        keys.add(key);
      }
    }
  }
  return keys;
};

const diffKeys = (expected: Iterable<string>, actual: Set<string>) => {
  const expectedSet = new Set(expected);
  return {
    added: [...actual].filter((k) => !expectedSet.has(k)).sort(),
    removed: [...expectedSet].filter((k) => !actual.has(k)).sort(),
  };
};

const readFixtureWomps = (): unknown[] => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'));
    if (isRecord(parsed) && Array.isArray(parsed.womps)) {
      return parsed.womps;
    }
  } catch {
    // Reported by the caller as "fixture unreadable"; not fatal on its own.
  }
  return [];
};

/**
 * Picks a small sample that still covers the cases that have bitten us: a null
 * display name, a named author, a null parcel_name with an address set, and
 * empty content. Falls back to the newest womps when a case is not present.
 */
const pickFixtureSample = (womps: unknown[]) => {
  const records = womps.filter(isRecord);
  const chosen: Record<string, unknown>[] = [];

  const want: ((w: Record<string, unknown>) => boolean)[] = [
    (w) => isRecord(w.author) && w.author.name === null,
    (w) => isRecord(w.author) && typeof w.author.name === 'string',
    (w) => w.parcel_name === null && typeof w.parcel_address === 'string',
    (w) => w.content === '' || w.content === null,
  ];

  for (const matches of want) {
    const hit = records.find((w) => matches(w) && !chosen.includes(w));
    if (hit) {
      chosen.push(hit);
    }
  }
  for (const w of records) {
    if (chosen.length >= FIXTURE_SIZE) {
      break;
    }
    if (!chosen.includes(w)) {
      chosen.push(w);
    }
  }

  return chosen
    .slice(0, FIXTURE_SIZE)
    .sort((a, b) => Number(b.id ?? 0) - Number(a.id ?? 0));
};

const EXIT_SHAPE_CHANGED = 1;

async function main() {
  const refresh = process.argv.includes('--refresh');

  out(`Checking ${WOMPS_API_URL}`);
  out();

  let payload: unknown;
  try {
    payload = await fetchWompsPayload();
  } catch (error) {
    // A Voxels outage is not a shape change. Say so and exit clean, otherwise
    // this check cries wolf every time their CDN hiccups and nobody reads it
    // on the day it matters.
    out('COULD NOT REACH THE API');
    out(`  ${error instanceof Error ? error.message : String(error)}`);
    out();
    out('No conclusion about the shape. Try again later.');
    return 0;
  }

  const entries =
    isRecord(payload) && Array.isArray(payload.womps) ? payload.womps : null;

  if (!entries) {
    out('SHAPE CHANGED: the response is not a womps envelope.');
    out(
      `  expected an object with a "womps" array, got top-level keys: ${
        isRecord(payload)
          ? Object.keys(payload).join(', ') || 'none'
          : typeof payload
      }`
    );
    return EXIT_SHAPE_CHANGED;
  }

  out(`Fetched ${entries.length} womps.`);
  out();

  let changed = false;

  // 1. Key set against what the code was written for.
  const liveKeys = keysOf(entries);
  const vsCode = diffKeys(EXPECTED_WOMP_KEYS, liveKeys);
  out('Womp keys vs EXPECTED_WOMP_KEYS in src/womps.ts:');
  if (vsCode.added.length === 0 && vsCode.removed.length === 0) {
    out('  unchanged');
  } else {
    changed = true;
    for (const key of vsCode.added) {
      out(`  + ${key}   (new key upstream)`);
    }
    for (const key of vsCode.removed) {
      out(`  - ${key}   (gone from upstream)`);
    }
  }
  out();

  // 2. Key set against the committed fixture, which is what the tests assert on.
  const fixtureWomps = readFixtureWomps();
  out('Womp keys vs test/fixtures/womps-current.json:');
  if (fixtureWomps.length === 0) {
    changed = true;
    out('  fixture missing or unreadable. Run with --refresh to capture one.');
  } else {
    const vsFixture = diffKeys(keysOf(fixtureWomps), liveKeys);
    if (vsFixture.added.length === 0 && vsFixture.removed.length === 0) {
      out('  unchanged');
    } else {
      changed = true;
      for (const key of vsFixture.added) {
        out(`  + ${key}`);
      }
      for (const key of vsFixture.removed) {
        out(`  - ${key}`);
      }
    }
  }
  out();

  // 3. The part that actually matters: does the bot's parser still work?
  out('Parsing every womp with parseWomp:');
  let parsed = 0;
  const failures: string[] = [];
  for (const entry of entries) {
    try {
      parseWomp(entry);
      parsed += 1;
    } catch (error) {
      const id = isRecord(entry) ? String(entry.id) : '<not an object>';
      failures.push(
        `  womp ${id}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  out(`  ${parsed}/${entries.length} parsed`);
  for (const line of failures.slice(0, 10)) {
    out(line);
  }
  if (failures.length > 10) {
    out(`  ...and ${failures.length - 10} more`);
  }
  if (failures.length > 0) {
    changed = true;
  }
  out();

  // 4. Show what a post would look like, so a human can sanity check the
  //    author and location without reading any code.
  const batch = parseWompsPayload(payload);
  out('Newest womps as the bot sees them:');
  for (const womp of batch.womps.slice(0, 3)) {
    out(
      `  #${womp.id} by ${womp.author} at ${womp.location || '(no location)'} ${womp.coords}`
    );
    out(`     "${womp.content}"`);
  }
  out();

  if (refresh) {
    const sample = pickFixtureSample(entries);
    writeFileSync(
      FIXTURE_PATH,
      `${JSON.stringify({ success: true, womps: sample }, null, 2)}\n`,
      'utf8'
    );
    out(
      `Refreshed ${FIXTURE_PATH} with ${sample.length} womps: ${sample.map((w) => w.id).join(', ')}`
    );
    out('Review the diff, then run the tests.');
    out();
    return 0;
  }

  if (changed) {
    out('SHAPE CHANGED. What to do:');
    out('  1. Read the diff above to see which field moved.');
    out('  2. Update parseWomp / EXPECTED_WOMP_KEYS in src/womps.ts.');
    out('  3. Run "yarn check:api --refresh" to recapture the fixture.');
    out('  4. Run "yarn test". Keep the legacy fixture passing.');
    return EXIT_SHAPE_CHANGED;
  }

  out('Shape unchanged. Nothing to do.');
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((error: unknown) => {
    out(`check:api itself blew up: ${String(error)}`);
    process.exit(EXIT_SHAPE_CHANGED);
  });
