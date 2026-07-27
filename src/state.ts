/**
 * The last posted womp id, persisted between runs.
 *
 * Why this exists: dedupe used to be purely temporal. Each run posted womps
 * created in the last WOMPTRON_INTERVAL seconds, and that only works if the
 * schedule actually fires on time. GitHub's scheduled events are best effort
 * and get dropped under load, so any womp created during a skipped interval
 * was never posted. Remembering the last id we handled removes the dependence
 * on run timing entirely: a run that fires late, or after five were skipped,
 * still picks up exactly what it missed.
 *
 * Where it lives: a small JSON file, restored and saved by the GitHub Actions
 * cache in .github/workflows/post.yml. See the comments there for the
 * trade-offs and for what happens if the cache is evicted.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { logger } from './logger';

export interface WomptronState {
  lastWompId: number;
  updatedAt: string;
}

export const DEFAULT_STATE_FILE = '.womptron-state/last-womp-id.json';

export const stateFilePath = () =>
  process.env.WOMPTRON_STATE_FILE ?? DEFAULT_STATE_FILE;

/**
 * Returns the stored state, or null for a cold start.
 *
 * A missing file and an unreadable one both count as a cold start, which the
 * caller answers by seeding from the newest womp and posting nothing. That is
 * the safe direction: the cost of a lost id is a few unposted womps, the cost
 * of guessing wrong the other way is a backlog dump at $0.015 a post.
 */
export const readState = (path = stateFilePath()): WomptronState | null => {
  if (!existsSync(path)) {
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as WomptronState).lastWompId !== 'number' ||
      !Number.isFinite((parsed as WomptronState).lastWompId)
    ) {
      logger.warn(
        `State file ${path} does not hold a numeric lastWompId. Treating this as a cold start.`
      );
      return null;
    }
    return parsed as WomptronState;
  } catch (error) {
    logger.warn(
      `Could not read state file ${path}: ${error instanceof Error ? error.message : String(error)}. Treating this as a cold start.`
    );
    return null;
  }
};

export const writeState = (lastWompId: number, path = stateFilePath()) => {
  const state: WomptronState = {
    lastWompId,
    updatedAt: new Date().toISOString(),
  };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  logger.info(`Stored last womp id ${lastWompId} in ${path}`);
};
