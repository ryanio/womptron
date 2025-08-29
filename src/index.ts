import fetch from 'node-fetch';
import { TwitterApi } from 'twitter-api-v2';
import { logger } from './logger';
import { base64Image, shortAddr, timeout, truncate } from './util';

export interface Womp {
  id: number;
  author: string;
  location: string;
  content: string;
  playUrl: string;
  imgSrc: string;
}

const {
  TWITTER_CONSUMER_KEY,
  TWITTER_CONSUMER_SECRET,
  TWITTER_ACCESS_TOKEN,
  TWITTER_ACCESS_TOKEN_SECRET,
  DEBUG,
} = process.env;

const WOMPTRON_INTERVAL = Number(process.env.WOMPTRON_INTERVAL ?? 60);

const client = new TwitterApi({
  appKey: TWITTER_CONSUMER_KEY!,
  appSecret: TWITTER_CONSUMER_SECRET!,
  accessToken: TWITTER_ACCESS_TOKEN!,
  accessSecret: TWITTER_ACCESS_TOKEN_SECRET!,
});

export const textForTweet = (womp: Womp) => {
  const { content, location, author, playUrl } = womp;
  return `"${content}" - at ${location} - by ${author} ${playUrl}`;
};

export const tweetWomp = async (womp: Womp) => {
  try {
    // Fetch and upload image
    const mediaUploadResponse = await client.v1.uploadMedia(
      Buffer.from(await base64Image(womp), 'base64')
    );

    // Add alt text
    const { content } = womp;
    if (content) {
      await client.v1.createMediaMetadata(mediaUploadResponse, {
        alt_text: { text: content },
      });
    }

    // Create tweet
    await client.v1.tweet(textForTweet(womp), {
      media_ids: mediaUploadResponse,
    });

    logger.info(`Tweeted womp #${womp.id}: ${textForTweet(womp)}`);
  } catch (error) {
    logger.error(`Error tweeting: ${JSON.stringify(error)}`);
  }
};

export const getWomps = async (): Promise<Womp[]> => {
  try {
    const response = await fetch(
      `https://www.voxels.com/api/womps.json?${Date.now()}`,
      { mode: 'no-cors' } as any
    );

    if (!response.ok) {
      const errorDetails = DEBUG ? await response.text() : '';
      logger.error(
        `Fetch Error - ${response.status}: ${response.statusText}`,
        errorDetails ? { debug: errorDetails } : {}
      );
      return [];
    }

    const result = await response.json();
    let { womps } = result;

    if (!womps || womps.length === 0) {
      logger.error('No womps returned', DEBUG ? { debug: result } : {});
      return [];
    }

    // since WOMPTRON_INTERVAL
    womps = womps
      .filter(
        (w) =>
          new Date(w.created_at).getTime() >
          Date.now() - WOMPTRON_INTERVAL * 1000
      )
      .reverse();

    womps = womps.map(async (womp) => {
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

    return await Promise.all(womps);
  } catch (error) {
    logger.error(`Fetch Error: ${error?.message ?? error}`);
    return [];
  }
};

async function main() {
  let tweeting = false;
  const wompsToTweet: Womp[] = [];

  const run = async () => {
    const womps = await getWomps();
    if (!womps) return;
    logger.info(`Found ${womps.length} new womps`);
    wompsToTweet.push(...womps);
    if (wompsToTweet.length > 0) {
      logger.info(`Tweet queue: ${wompsToTweet.length} womps`);
    }
    tweetWomps();
  };

  const tweetWomps = async () => {
    if (tweeting) return;
    tweeting = true;
    while (wompsToTweet.length > 0) {
      const womp = wompsToTweet.shift()!;
      await tweetWomp(womp);
      await timeout(2000);
    }
    tweeting = false;
  };

  run();

  const interval = setInterval(run.bind(this), WOMPTRON_INTERVAL * 1000);

  process.on('SIGINT', () => {
    logger.info('Caught interrupt signal. Stopping...');
    clearInterval(interval);
    process.exit();
  });
}

main();
