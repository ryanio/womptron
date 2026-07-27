// Loads .env before anything reads process.env, for local runs. In CI the
// values come from the workflow's env block.
import 'dotenv/config';
import { type EUploadMimeType, TwitterApi } from 'twitter-api-v2';
import { logger } from './logger';
import { shortAddr, timeout, truncate } from './util';

/** A womp as the Voxels API returns it, before normalisation. */
type ApiWomp = {
  id: number;
  created_at: string;
  coords: string;
  image_url: string;
  author: string;
  author_name?: string | null;
  content?: string | null;
  parcel_name?: string | null;
  parcel_address?: string | null;
};

type WompsApiResponse = { womps?: ApiWomp[] };

export type Womp = {
  id: number;
  author: string;
  location: string;
  coords: string;
  content: string;
  playUrl: string;
  imgSrc: string;
};

const {
  TWITTER_CONSUMER_KEY,
  TWITTER_CONSUMER_SECRET,
  TWITTER_ACCESS_TOKEN,
  TWITTER_ACCESS_TOKEN_SECRET,
} = process.env;

/**
 * Dedupe window, in seconds. There is no persistent record of what has been
 * posted, so each run tweets womps created in the last WOMPTRON_INTERVAL
 * seconds. It MUST match the cron period in .github/workflows/tweet.yml
 * (15 minutes = 900). Too small and womps fall through the gap between runs;
 * too large and consecutive runs overlap and re-post, and every duplicate is a
 * billed request.
 */
const WOMPTRON_INTERVAL = Number(process.env.WOMPTRON_INTERVAL ?? 900);
const MILLISECONDS_PER_SECOND = 1000;
const TWEET_DELAY_MS = 2000;

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
const COST_PER_TWEET_USD = WOMPTRON_INCLUDE_URL ? 0.2 : 0.015;

/**
 * Ceiling on posts per run. Voxels is quiet today, but the womps API returns
 * up to 50 per page, so a backfill or a traffic spike could otherwise bill an
 * unbounded burst. Anything over the cap is dropped with a loud log line.
 */
const WOMPTRON_MAX_TWEETS_PER_RUN = Number(
  process.env.WOMPTRON_MAX_TWEETS_PER_RUN ?? 5
);

// Create a function to get the client so it can be mocked in tests
export const getTwitterClient = () => {
  if (
    !(
      TWITTER_CONSUMER_KEY &&
      TWITTER_CONSUMER_SECRET &&
      TWITTER_ACCESS_TOKEN &&
      TWITTER_ACCESS_TOKEN_SECRET
    )
  ) {
    throw new Error(
      'Missing required Twitter API credentials in environment variables'
    );
  }

  return new TwitterApi({
    appKey: TWITTER_CONSUMER_KEY,
    appSecret: TWITTER_CONSUMER_SECRET,
    accessToken: TWITTER_ACCESS_TOKEN,
    accessSecret: TWITTER_ACCESS_TOKEN_SECRET,
  });
};

const client = getTwitterClient();

export const textForTweet = (womp: Womp) => {
  const { content, location, coords, author, playUrl } = womp;

  const parts: string[] = [];

  if (content) {
    parts.push(`"${content}"`);
  }

  // The coords used to reach the reader only through the play URL. With the
  // URL gone by default they go in the location text, so the spot is still
  // findable. A parcel with no name shows the coords alone.
  let where = location;
  if (coords) {
    where = location ? `${location} (${coords})` : coords;
  }
  if (where) {
    parts.push(`at ${where}`);
  }

  parts.push(`by ${author}`);

  if (WOMPTRON_INCLUDE_URL) {
    parts.push(playUrl);
  }

  return parts.join(' - ');
};

export const tweetWomp = async (womp: Womp, twitterClient = client) => {
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
    // twitterClient.v1.uploadMedia, still points at upload.x.com/1.1/ in
    // twitter-api-v2 1.25.0, and X sunset that endpoint on 2025-06-09.
    const mediaUploadResponse = await twitterClient.v2.uploadMedia(
      imageBuffer,
      {
        media_type: contentType as EUploadMimeType,
      }
    );

    // Create tweet using v2 API (works with Basic tier)
    await twitterClient.v2.tweet({
      text: textForTweet(womp),
      media: { media_ids: [mediaUploadResponse] },
    });

    logger.info(`Tweeted womp #${womp.id}: ${textForTweet(womp)}`);
  } catch (error) {
    const errorMessage =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
    logger.error(`Error tweeting: ${errorMessage}`);

    // Log additional error details if available
    if (error instanceof Error && error.stack) {
      logger.debug(`Stack trace: ${error.stack}`);
    }
  }
};

export const getWomps = async (): Promise<Womp[]> => {
  try {
    const response = await fetch(
      `https://www.voxels.com/api/womps.json?${Date.now()}`
    );

    if (!response.ok) {
      const errorDetails = await response.text();
      logger.error(`Fetch Error - ${response.status}: ${response.statusText}`);
      logger.debug('Response details:', { errorDetails });
      return [];
    }

    const result = (await response.json()) as WompsApiResponse;
    const { womps } = result;

    if (!womps || womps.length === 0) {
      logger.error('No womps returned');
      logger.debug('API response:', { result });
      return [];
    }

    // Keep only womps created within the dedupe window. This is the whole
    // dedupe story: nothing records what has already been posted, so a rerun
    // of the same period re-tweets it, and every duplicate is a billed
    // request. Fixing that properly means persisting the last posted womp id
    // somewhere that survives the job. Until then, expect the occasional
    // duplicate.
    const recent = womps
      .filter(
        (w) =>
          new Date(w.created_at).getTime() >
          Date.now() - WOMPTRON_INTERVAL * MILLISECONDS_PER_SECOND
      )
      .reverse();

    return recent.map((womp): Womp => {
      const { id, image_url: imgSrc, coords } = womp;
      const author = womp.author_name ?? shortAddr(womp.author);
      const playUrl = `https://voxels.com/play?coords=${coords}`;

      let content = womp.content ?? '';
      let location = womp.parcel_name ?? womp.parcel_address ?? '';

      // remove unsolicited mentions by removing @ symbol
      const search =
        /(^|\s|\n|\^|\(|\)|\{|\}|\[|\]|\+|-|\\|\/|\.|,|\|||<|>|\?|'|"|:|;)@(\w*)/g;
      content = content.replace(search, '$1$2');
      location = location.replace(search, '$1$2');

      content = content.trim();
      content = truncate(content);

      return { id, content, location, coords, author, playUrl, imgSrc };
    });
  } catch (error) {
    const errorMessage =
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : String(error);
    logger.error(`Fetch Error: ${errorMessage}`);

    // Log additional error details if available
    if (error instanceof Error && error.stack) {
      logger.debug(`Stack trace: ${error.stack}`);
    }
    return [];
  }
};

/**
 * Trims a queue of womps (oldest first) down to WOMPTRON_MAX_TWEETS_PER_RUN,
 * keeping the newest. Mutates the queue in place so callers holding the array
 * see the trim, and logs what was dropped.
 */
export const applyTweetCap = (queue: Womp[]) => {
  if (queue.length <= WOMPTRON_MAX_TWEETS_PER_RUN) {
    return queue;
  }

  const skipped = queue.length - WOMPTRON_MAX_TWEETS_PER_RUN;
  const dropped = queue.splice(0, skipped);
  const costAvoided = (skipped * COST_PER_TWEET_USD).toFixed(3);

  logger.warn(
    `Tweet cap hit: ${queue.length + skipped} womps queued, tweeting the newest ${WOMPTRON_MAX_TWEETS_PER_RUN}, skipping ${skipped}. Estimated cost avoided: $${costAvoided}. Raise WOMPTRON_MAX_TWEETS_PER_RUN to post more.`
  );
  logger.warn(`Skipped womp ids: ${dropped.map((w) => w.id).join(', ')}`);

  return queue;
};

/**
 * One pass: fetch, cap, tweet, resolve. Returns how many were posted.
 *
 * Every send is awaited before the promise settles, so the process never exits
 * with tweets still in flight.
 */
export async function runOnce(): Promise<number> {
  const queue = await getWomps();
  if (!queue || queue.length === 0) {
    logger.info('No new womps');
    return 0;
  }

  logger.info(`Found ${queue.length} new womps`);
  applyTweetCap(queue);

  let posted = 0;
  while (queue.length > 0) {
    const womp = queue.shift();
    if (!womp) {
      continue;
    }
    await tweetWomp(womp);
    posted += 1;
    // Only pace between tweets, never after the last one. A trailing sleep is
    // dead time a scheduled job pays for.
    if (queue.length > 0) {
      await timeout(TWEET_DELAY_MS);
    }
  }

  return posted;
}

// Only run if this file is executed directly (not imported in tests)
if (require.main === module) {
  runOnce()
    .then((posted) => {
      logger.info(`Run complete, ${posted} tweeted`);
      process.exit(0);
    })
    .catch((error: unknown) => {
      logger.error(`Run failed: ${String(error)}`);
      process.exit(1);
    });
}
