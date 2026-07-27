/**
 * Fixture loaders.
 *
 * womps-current.json and womps-legacy.json are captured from the real Voxels
 * API, not hand written, so the tests cannot quietly drift away from what the
 * feed actually returns. Refresh the current one with:
 *
 *   yarn check:api --refresh
 *
 * womps-malformed.json is the exception: those shapes are invented on purpose
 * to prove one bad womp does not take down the batch.
 *
 * Loaded with fs rather than an import so the fixtures stay plain JSON that a
 * human can diff, without turning on resolveJsonModule for the build.
 */

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const load = (name: string): { success: boolean; womps: unknown[] } =>
  JSON.parse(readFileSync(join(__dirname, name), 'utf8'));

/** The shape the API returns today: author is an object with name and owner. */
export const currentApiResponse = load('womps-current.json');

/** The shape it returned before: author is a wallet string, name is top level. */
export const legacyApiResponse = load('womps-legacy.json');

/** Deliberate breakage. Every entry but the last one must fail to parse. */
export const malformedApiResponse = load('womps-malformed.json');

/**
 * Finds the first womp matching a predicate.
 *
 * Tests select womps by the property under test rather than by hardcoded id,
 * so `yarn check:api --refresh` can pull in a fresh sample without a wave of
 * unrelated test failures. Throws with a readable message when the refreshed
 * fixture no longer covers a case, which is itself worth knowing.
 */
export const findWomp = (
  response: { womps: unknown[] },
  description: string,
  matches: (womp: any) => boolean
): any => {
  const hit = response.womps.find(
    (womp) => typeof womp === 'object' && womp !== null && matches(womp)
  );
  if (!hit) {
    throw new Error(
      `No womp in the fixture matches "${description}". Recapture one that does, or drop the test.`
    );
  }
  return hit;
};

/** Fixture womp ids, newest first, which is the order the parser returns. */
export const idsNewestFirst = (response: { womps: unknown[] }): number[] =>
  response.womps
    .map((womp: any) => womp?.id)
    .filter((id): id is number => typeof id === 'number')
    .sort((a, b) => b - a);

/**
 * Rewrites created_at on every womp so the recency filter sees them as new,
 * newest first, one minute apart.
 */
export const asRecent = (response: { womps: unknown[] }) => ({
  success: true,
  womps: response.womps.map((womp, index) => {
    if (typeof womp !== 'object' || womp === null) {
      return womp;
    }
    return {
      ...womp,
      created_at: new Date(Date.now() - index * 60_000).toISOString(),
    };
  }),
});
