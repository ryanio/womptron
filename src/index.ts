import fetch from 'node-fetch';
import { TwitterApi } from 'twitter-api-v2';
import { logger } from './logger';
import { shortAddr, timeout, truncate } from './util';

export type Womp = {
  id: number;
  author: string;
  location: string;
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

const WOMPTRON_INTERVAL = Number(process.env.WOMPTRON_INTERVAL ?? 60);
const MILLISECONDS_PER_SECOND = 1000;
const TWEET_DELAY_MS = 2000;

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
  const { content, location, author, playUrl } = womp;
  return `"${content}" - at ${location} - by ${author} ${playUrl}`;
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

    // Upload image directly from response buffer
    const imageBuffer = await response.buffer();

    // Get content type from response headers, fallback to image/jpeg
    const contentType = response.headers.get('content-type') || 'image/jpeg';

    const mediaUploadResponse = await twitterClient.v1.uploadMedia(
      imageBuffer,
      {
        type: contentType,
        mimeType: contentType,
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

    const result = await response.json();
    let { womps } = result;

    if (!womps || womps.length === 0) {
      logger.error('No womps returned');
      logger.debug('API response:', { result });
      return [];
    }

    // since WOMPTRON_INTERVAL
    womps = womps
      .filter(
        (w) =>
          new Date(w.created_at).getTime() >
          Date.now() - WOMPTRON_INTERVAL * MILLISECONDS_PER_SECOND
      )
      .reverse();

    womps = womps.map((womp) => {
      const { id, image_url: imgSrc, coords } = womp;
      const author = womp.author_name ?? shortAddr(womp.author);
      const playUrl = `https://voxels.com/play?coords=${coords}`;

      let content = womp.content;
      let location = womp.parcel_name ?? womp.parcel_address;

      // remove unsolicited mentions by removing @ symbol
      const search =
        /(^|\s|\n|\^|\(|\)|\{|\}|\[|\]|\+|-|\\|\/|\.|,|\|||<|>|\?|'|"|:|;)@(\w*)/g;
      content = content.replace(search, '$1$2');
      location = location.replace(search, '$1$2');

      content = content.trim();
      content = truncate(content);

      return { id, content, location, author, playUrl, imgSrc };
    });

    return womps;
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

export function main() {
  let tweeting = false;
  const wompsToTweet: Womp[] = [];

  const run = async () => {
    const womps = await getWomps();
    if (!womps) {
      return;
    }
    logger.info(`Found ${womps.length} new womps`);
    wompsToTweet.push(...womps);
    if (wompsToTweet.length > 0) {
      logger.info(`Tweet queue: ${wompsToTweet.length} womps`);
    }
    // Fire and forget async function
    tweetWomps();
  };

  const tweetWomps = async () => {
    // Prevent concurrent tweeting operations
    // biome-ignore lint/nursery/noUnnecessaryConditions: This is a semaphore pattern
    if (tweeting) {
      return;
    }
    tweeting = true;

    try {
      while (wompsToTweet.length > 0) {
        const womp = wompsToTweet.shift();
        if (womp) {
          await tweetWomp(womp);
          await timeout(TWEET_DELAY_MS);
        }
      }
    } finally {
      tweeting = false;
    }
  };

  run();

  const interval = setInterval(
    run.bind(this),
    WOMPTRON_INTERVAL * MILLISECONDS_PER_SECOND
  );

  process.on('SIGINT', () => {
    logger.info('Caught interrupt signal. Stopping...');
    clearInterval(interval);
    process.exit();
  });

  return interval;
}

// Only run main if this file is executed directly (not imported in tests)
if (require.main === module) {
  main();
}
