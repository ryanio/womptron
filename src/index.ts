// Loads .env before anything reads process.env, for local runs. In CI the
// values come from the workflow's env block.
import 'dotenv/config';
import { type EUploadMimeType, TwitterApi } from 'twitter-api-v2';
import { logger } from './logger';
import { readState, writeState } from './state';
import { timeout } from './util';
import { getWomps, type Womp } from './womps';

export type { Womp } from './womps';

/**
 * Credentials. The X_* names are the current ones; the TWITTER_* names are what
 * the GitHub Actions secrets in ryanio/womptron are still called, and what an
 * older local .env will have. X_* wins where both are set, so an operator can
 * migrate the secrets one at a time without a flag day. Nothing here needs the
 * new names to exist.
 *
 * The npm package is still called twitter-api-v2 and its API surface is still
 * v2.tweet / v2.uploadMedia. Those are third party and stay as they are.
 */
const credential = (name: string) =>
  process.env[`X_${name}`] ?? process.env[`TWITTER_${name}`];

const X_CONSUMER_KEY = credential('CONSUMER_KEY');
const X_CONSUMER_SECRET = credential('CONSUMER_SECRET');
const X_ACCESS_TOKEN = credential('ACCESS_TOKEN');
const X_ACCESS_TOKEN_SECRET = credential('ACCESS_TOKEN_SECRET');

const MILLISECONDS_PER_SECOND = 1000;
const POST_DELAY_MS = 2000;

/**
 * Staleness ceiling, in seconds. This used to be the whole dedupe mechanism,
 * and it had to match the cron period exactly. It does not any more: the last
 * posted womp id in .womptron-state is the real dedupe, and it does not care
 * when or whether a scheduled run fires.
 *
 * What the interval still buys is a bound on how old a womp can be and still
 * get posted. If the workflow is disabled for a week and then re-enabled, the
 * stored id makes every womp from that week "new", and posting a seven day old
 * womp as news is wrong. Anything older than this is skipped, and the stored
 * id still advances past it so it is not reconsidered.
 */
const WOMPTRON_INTERVAL = Number(process.env.WOMPTRON_INTERVAL ?? 86_400);

/**
 * X bills post creation per request, and a post containing a URL costs far
 * more than one without:
 *   $0.015 per post without a URL
 *   $0.200 per post with a URL (13x)
 *
 * At the current womp rate (roughly 1.2 per day) that is about $0.54/month
 * without links versus about $7.20/month with them. The coords now ride along
 * in the location text instead, so a reader can still find the spot by typing
 * them into Voxels. Set WOMPTRON_INCLUDE_URL=true to put the play link back
 * and accept the higher bill.
 */
const WOMPTRON_INCLUDE_URL = process.env.WOMPTRON_INCLUDE_URL === 'true';
const COST_PER_POST_USD = WOMPTRON_INCLUDE_URL ? 0.2 : 0.015;

/**
 * Ceiling on posts per run. Voxels is quiet today, but the womps API returns
 * up to 50 per page, so a backfill or a traffic spike could otherwise bill an
 * unbounded burst. Anything over the cap is dropped with a loud log line.
 *
 * WOMPTRON_MAX_TWEETS_PER_RUN is the previous name, still read as a fallback.
 */
const WOMPTRON_MAX_POSTS_PER_RUN = Number(
  process.env.WOMPTRON_MAX_POSTS_PER_RUN ??
    process.env.WOMPTRON_MAX_TWEETS_PER_RUN ??
    5
);

// Create a function to get the client so it can be mocked in tests
export const getXClient = () => {
  if (
    !(
      X_CONSUMER_KEY &&
      X_CONSUMER_SECRET &&
      X_ACCESS_TOKEN &&
      X_ACCESS_TOKEN_SECRET
    )
  ) {
    throw new Error(
      'Missing required X API credentials. Set X_CONSUMER_KEY, X_CONSUMER_SECRET, X_ACCESS_TOKEN and X_ACCESS_TOKEN_SECRET (the older TWITTER_* names are also accepted).'
    );
  }

  return new TwitterApi({
    appKey: X_CONSUMER_KEY,
    appSecret: X_CONSUMER_SECRET,
    accessToken: X_ACCESS_TOKEN,
    accessSecret: X_ACCESS_TOKEN_SECRET,
  });
};

const client = getXClient();

/**
 * Two lines: a sentence, then the coords on their own.
 *
 * The image is the post. The text is a caption, so it reads as prose rather
 * than as a dash-delimited record. Captions are often three characters ("666"),
 * and the old ` - ` join spent three separators framing them.
 *
 * The second line is a host-less path (`/play?coords=NE@49E,242N`). Paste it
 * after voxels.com and it is the same link the bot used to post. It sits alone
 * so it is easy to select, and it is the last thing in the post so a client
 * truncating the text loses the least useful part.
 *
 * That shape is also what keeps this affordable. X bills $0.200 for a post
 * containing a URL against $0.015 without, and a path with no scheme and no
 * host is not one. Verified against a live post: X returned zero url entities
 * for exactly this string, and did not read the `@` in the coords as a mention
 * either, since it sits between letters rather than at a word boundary.
 *
 * Do not prepend `voxels.com`. That is a real domain with a real TLD, and it
 * flips every post to the higher rate. `WOMPTRON_INCLUDE_URL=true` does exactly
 * that, deliberately, for anyone who wants the clickable link and will pay for
 * it.
 */
export const textForPost = (womp: Womp) => {
  const { content, location, coords, author, playUrl } = womp;

  // Every clause is optional except the byline, so build the sentence from
  // whatever this womp actually has rather than emitting empty scaffolding.
  let sentence = content ? `"${content}"` : '';
  if (location) {
    sentence += sentence ? ` at ${location},` : `At ${location},`;
  } else if (sentence) {
    sentence += ',';
  }
  sentence += sentence ? ` by ${author}` : `By ${author}`;

  const trailer = coords
    ? WOMPTRON_INCLUDE_URL
      ? playUrl
      : `/play?coords=${coords}`
    : WOMPTRON_INCLUDE_URL
      ? playUrl
      : '';

  return trailer ? `${sentence}\n${trailer}` : sentence;
};

/** Posts one womp. Returns whether it went out, so the caller can decide
 * whether to advance the stored id past it. */
export const postWomp = async (womp: Womp, xClient = client) => {
  try {
    // Fetch image directly
    const response = await fetch(womp.imgSrc);
    if (!response.ok) {
      throw new Error(
        `Failed to fetch image: ${response.status} ${response.statusText} for URL: ${womp.imgSrc}`
      );
    }

    // Upload image directly from the response body
    const imageBuffer = Buffer.from(await response.arrayBuffer());

    // Get content type from response headers, fallback to image/jpeg
    const contentType = response.headers.get('content-type') || 'image/jpeg';

    // v2 media upload (POST /2/media/upload). The old v1.1 helper,
    // xClient.v1.uploadMedia, still points at upload.x.com/1.1/ in
    // twitter-api-v2 1.25.0, and X sunset that endpoint on 2025-06-09.
    const mediaUploadResponse = await xClient.v2.uploadMedia(imageBuffer, {
      media_type: contentType as EUploadMimeType,
    });

    await xClient.v2.tweet({
      text: textForPost(womp),
      media: { media_ids: [mediaUploadResponse] },
    });

    logger.info(`Posted womp #${womp.id}: ${textForPost(womp)}`);
    return true;
  } catch (error) {
    const errorMessage =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
    logger.error(`Error posting womp #${womp.id}: ${errorMessage}`);

    // Log additional error details if available
    if (error instanceof Error && error.stack) {
      logger.debug(`Stack trace: ${error.stack}`);
    }
    return false;
  }
};

/**
 * Trims a queue of womps (oldest first) down to WOMPTRON_MAX_POSTS_PER_RUN,
 * keeping the newest. Mutates the queue in place so callers holding the array
 * see the trim, and logs what was dropped.
 */
export const applyPostCap = (queue: Womp[]) => {
  if (queue.length <= WOMPTRON_MAX_POSTS_PER_RUN) {
    return queue;
  }

  const skipped = queue.length - WOMPTRON_MAX_POSTS_PER_RUN;
  const dropped = queue.splice(0, skipped);
  const costAvoided = (skipped * COST_PER_POST_USD).toFixed(3);

  logger.warn(
    `Post cap hit: ${queue.length + skipped} womps queued, posting the newest ${WOMPTRON_MAX_POSTS_PER_RUN}, skipping ${skipped}. Estimated cost avoided: $${costAvoided}. Raise WOMPTRON_MAX_POSTS_PER_RUN to post more.`
  );
  logger.warn(`Skipped womp ids: ${dropped.map((w) => w.id).join(', ')}`);

  return queue;
};

export interface RunResult {
  /** True when there was no stored id and this run only seeded one. */
  coldStart: boolean;
  /** Posts that were attempted and failed. Non-zero means a red run. */
  failed: number;
  /** Womps new by id but older than WOMPTRON_INTERVAL. */
  skippedStale: number;
  posted: number;
}

const emptyResult = (): RunResult => ({
  coldStart: false,
  failed: 0,
  skippedStale: 0,
  posted: 0,
});

/**
 * One pass: fetch, dedupe against the stored id, cap, post, store.
 *
 * Throws when the feed could not be fetched or parsed. That is deliberate: the
 * caller turns a throw into a non-zero exit, so a broken API can never be
 * mistaken for a quiet night. "Zero new womps" returns normally.
 *
 * Every send is awaited before the promise settles, so the process never exits
 * with posts still in flight.
 */
export async function runOnce(): Promise<RunResult> {
  const stored = readState();
  const batch = await getWomps();
  const result = emptyResult();

  if (batch.newestId === null) {
    logger.warn('No womps in the feed at all, leaving the stored id alone.');
    return result;
  }

  if (stored === null) {
    // Cold start. Seed from the newest womp and post nothing, so reviving the
    // bot or losing the cache never dumps a backlog onto the timeline.
    writeState(batch.newestId);
    logger.info(
      `Cold start: seeded the last posted womp id to ${batch.newestId} and posted nothing. The next run posts anything newer than that.`
    );
    result.coldStart = true;
    return result;
  }

  if (batch.newestId < stored.lastWompId) {
    // Either Voxels renumbered ids or the feed is serving something odd.
    // Either way the bot would sit silent forever, which is the failure mode
    // this rewrite exists to eliminate, so make it visible instead.
    throw new Error(
      `Stored womp id ${stored.lastWompId} is newer than anything in the feed (newest is ${batch.newestId}). The bot will post nothing until this is resolved. Delete ${JSON.stringify(process.env.WOMPTRON_STATE_FILE ?? '.womptron-state/last-womp-id.json')} to re-seed if the id space really did change.`
    );
  }

  const oldestAllowed =
    Date.now() - WOMPTRON_INTERVAL * MILLISECONDS_PER_SECOND;

  // Oldest first, so the timeline reads in the order things happened.
  const unposted = batch.womps
    .filter((w) => w.id > stored.lastWompId)
    .sort((a, b) => a.id - b.id);

  const queue = unposted.filter((w) => w.createdAt >= oldestAllowed);
  result.skippedStale = unposted.length - queue.length;

  if (result.skippedStale > 0) {
    logger.warn(
      `Skipped ${result.skippedStale} womps that are new to us but older than WOMPTRON_INTERVAL (${WOMPTRON_INTERVAL}s).`
    );
  }

  if (queue.length === 0) {
    logger.info('No new womps');
    writeState(batch.newestId);
    return result;
  }

  logger.info(`Found ${queue.length} new womps`);
  applyPostCap(queue);

  // Advance the stored id only as far as we are confident. On a failure we
  // stop the pass and leave the id behind the womp that failed, so the next
  // run retries it instead of losing it.
  let cursor = stored.lastWompId;
  for (let i = 0; i < queue.length; i += 1) {
    const womp = queue[i];
    // Sequential on purpose. X rate-limits post creation, and the pacing below
    // only means anything if the sends do not overlap.
    const sent = await postWomp(womp);
    if (!sent) {
      result.failed += 1;
      break;
    }
    result.posted += 1;
    cursor = womp.id;
    // Only pace between posts, never after the last one. A trailing sleep is
    // dead time a scheduled job pays for.
    if (i < queue.length - 1) {
      await timeout(POST_DELAY_MS);
    }
  }

  // A clean pass means everything in the response is handled, including womps
  // the cap dropped and womps skipped as stale, so jump straight to the newest.
  writeState(result.failed === 0 ? batch.newestId : cursor);

  return result;
}

// Only run if this file is executed directly (not imported in tests)
if (require.main === module) {
  runOnce()
    .then((result) => {
      if (result.failed > 0) {
        logger.error(
          `Run finished with ${result.failed} failed post(s) after ${result.posted} successful. Exiting non-zero so this run is not mistaken for a quiet one.`
        );
        process.exit(1);
      }
      logger.info(
        result.coldStart
          ? 'Run complete, cold start seeded, 0 posted'
          : `Run complete, ${result.posted} posted`
      );
      process.exit(0);
    })
    .catch((error: unknown) => {
      logger.error(
        `Run failed: ${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}`
      );
      if (error instanceof Error && error.stack) {
        logger.debug(`Stack trace: ${error.stack}`);
      }
      process.exit(1);
    });
}
