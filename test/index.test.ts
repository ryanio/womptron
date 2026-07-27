import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TwitterApi } from 'twitter-api-v2';
import { currentApiResponse, idsNewestFirst } from './fixtures';

jest.mock('twitter-api-v2');
jest.mock('../src/logger');
jest.mock('../src/util', () => ({
  ...jest.requireActual('../src/util'),
  timeout: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('../src/womps', () => ({
  ...jest.requireActual('../src/womps'),
  getWomps: jest.fn(),
}));

// The GitHub Actions secrets are still called TWITTER_*, so the fallback path
// is what production actually exercises. The X_* override gets its own test.
const legacyEnv = {
  TWITTER_CONSUMER_KEY: 'test_consumer_key',
  TWITTER_CONSUMER_SECRET: 'test_consumer_secret',
  TWITTER_ACCESS_TOKEN: 'test_access_token',
  TWITTER_ACCESS_TOKEN_SECRET: 'test_access_token_secret',
};

let stateDir: string;

// Re-imports src/index with temporary env overrides, since the module reads
// its config at load time. An undefined value unsets the variable.
const withEnv = (env: Record<string, string | undefined>, fn: () => void) => {
  const previous = { ...process.env };
  for (const [name, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = value;
    }
  }
  try {
    jest.isolateModules(fn);
  } finally {
    process.env = previous;
  }
};

const parse = (response: unknown) => {
  const { parseWompsPayload } = jest.requireActual('../src/womps');
  return parseWompsPayload(response);
};

/** The captured live fixture, parsed, with every womp made recent. */
const recentBatch = () => {
  const womps = currentApiResponse.womps.map((womp: any, index: number) => ({
    ...womp,
    created_at: new Date(Date.now() - index * 60_000).toISOString(),
  }));
  return parse({ success: true, womps });
};

/**
 * Fixture womp ids, newest first, so these tests survive
 * `yarn check:api --refresh` pulling in a different sample.
 * ids[0] is the newest, ids.at(-1) the oldest.
 */
const ids = idsNewestFirst(currentApiResponse);

// One client object for the whole file, because src/index captures the client
// at module load and that module stays cached across tests. Swapping in a new
// object per test would leave runOnce posting to a client nobody is watching.
const mockXClient = {
  v2: {
    tweet: jest.fn(),
    uploadMedia: jest.fn(),
  },
};

let mockFetch: jest.MockedFunction<typeof fetch>;
let mockLogger: any;

beforeAll(() => {
  // src/index.ts imports dotenv/config, so a developer's local .env would
  // otherwise leak into these tests. Pin every knob the bot reads. dotenv does
  // not override values already present in process.env, so setting them here
  // wins.
  for (const name of [
    'X_CONSUMER_KEY',
    'X_CONSUMER_SECRET',
    'X_ACCESS_TOKEN',
    'X_ACCESS_TOKEN_SECRET',
    'WOMPTRON_MAX_TWEETS_PER_RUN',
  ]) {
    delete process.env[name];
  }
  Object.assign(process.env, legacyEnv, {
    WOMPTRON_INCLUDE_URL: 'false',
    WOMPTRON_INTERVAL: '86400',
    WOMPTRON_MAX_POSTS_PER_RUN: '5',
  });
});

beforeEach(() => {
  jest.clearAllMocks();

  stateDir = mkdtempSync(join(tmpdir(), 'womptron-test-'));
  process.env.WOMPTRON_STATE_FILE = join(stateDir, 'last-womp-id.json');

  // mockReset clears the queued *Once implementations that individual tests
  // leave behind; clearAllMocks on its own does not.
  mockXClient.v2.tweet
    .mockReset()
    .mockResolvedValue({ data: { id: 'post_1' } });
  mockXClient.v2.uploadMedia.mockReset().mockResolvedValue('mock_media_id_123');
  (TwitterApi as jest.MockedClass<typeof TwitterApi>).mockImplementation(
    () => mockXClient as never
  );

  mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
  global.fetch = mockFetch;

  mockLogger = {
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  };
  const loggerModule = require('../src/logger');
  loggerModule.logger = mockLogger;
});

afterEach(() => {
  rmSync(stateDir, { force: true, recursive: true });
  delete process.env.WOMPTRON_STATE_FILE;
});

/** Queues a successful image download for postWomp. */
const mockImageDownload = (times = 1) => {
  const bytes = new TextEncoder().encode('fake_image_data');
  for (let i = 0; i < times; i += 1) {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: jest.fn().mockResolvedValue(bytes.buffer),
      headers: { get: jest.fn().mockReturnValue('image/jpeg') },
    } as any);
  }
};

const sampleWomp = () => ({
  author: '0x889b4…57c8b',
  content: 'nice',
  coords: 'E@247W,337N,5.5U',
  createdAt: Date.now(),
  id: 80_643,
  imgSrc: 'https://media.crvox.com/womps/x/a.jpg',
  location: 'PIGGYBANK',
  playUrl: 'https://voxels.com/play?coords=E@247W,337N,5.5U',
});

describe('Credentials', () => {
  test('falls back to the TWITTER_* names that are still in GitHub secrets', () => {
    withEnv({}, () => {
      require('../src/index');
    });

    expect(TwitterApi).toHaveBeenCalledWith({
      appKey: 'test_consumer_key',
      appSecret: 'test_consumer_secret',
      accessToken: 'test_access_token',
      accessSecret: 'test_access_token_secret',
    });
  });

  test('prefers the X_* names when both are set', () => {
    withEnv(
      {
        X_CONSUMER_KEY: 'x_key',
        X_CONSUMER_SECRET: 'x_secret',
        X_ACCESS_TOKEN: 'x_token',
        X_ACCESS_TOKEN_SECRET: 'x_token_secret',
      },
      () => {
        require('../src/index');
      }
    );

    expect(TwitterApi).toHaveBeenCalledWith({
      appKey: 'x_key',
      appSecret: 'x_secret',
      accessToken: 'x_token',
      accessSecret: 'x_token_secret',
    });
  });
});

describe('textForPost', () => {
  test('formats post text correctly', () => {
    const { textForPost } = require('../src/index');

    // A sentence, then the coords alone on the second line.
    expect(textForPost(sampleWomp())).toBe(
      '"nice" at PIGGYBANK, by 0x889b4…57c8b\n/play?coords=E@247W,337N,5.5U'
    );
  });

  test('handles special characters in content', () => {
    const { textForPost } = require('../src/index');

    const result = textForPost({
      ...sampleWomp(),
      content: 'Hello @world & "friends"',
    });

    expect(result).toContain('Hello @world & "friends"');
  });

  test('handles empty content gracefully', () => {
    const { textForPost } = require('../src/index');

    const result = textForPost({ ...sampleWomp(), content: '' });

    // The sentence starts at the location, capitalised, with no empty quotes.
    expect(result).toBe(
      'At PIGGYBANK, by 0x889b4…57c8b\n/play?coords=E@247W,337N,5.5U'
    );
    expect(result).not.toContain('""');
  });

  test('handles empty location gracefully', () => {
    const { textForPost } = require('../src/index');

    const result = textForPost({ ...sampleWomp(), location: '' });

    // No parcel name means no "at" clause at all. The coords still carry the
    // location on the second line, so nothing is lost.
    expect(result).toBe(
      '"nice", by 0x889b4…57c8b\n/play?coords=E@247W,337N,5.5U'
    );
    expect(result).not.toContain('at ,');
    expect(result).not.toContain('at  ');
  });

  test('handles both empty content and location', () => {
    const { textForPost } = require('../src/index');

    const result = textForPost({
      ...sampleWomp(),
      content: '',
      coords: '',
      location: '',
    });

    // Nothing left but the byline, so it opens the sentence and is capitalised.
    expect(result).toBe('By 0x889b4…57c8b');
    expect(result).not.toContain('\n');
  });

  test('omits the play URL by default', () => {
    const { textForPost } = require('../src/index');

    const result = textForPost(sampleWomp());

    expect(result).not.toContain('https://');
    expect(result).toContain('E@247W,337N,5.5U');
  });

  test('the coords line carries no scheme and no host, which is what keeps it cheap', () => {
    const { textForPost } = require('../src/index');

    const trailer = textForPost(sampleWomp()).split('\n')[1];

    // X bills $0.200 for a post containing a URL against $0.015 without. A
    // path with no scheme and no host is not one, verified against a live
    // post that came back with zero url entities. Any of these creeping in
    // would 13x every post silently, so assert their absence rather than
    // trusting the format string not to drift.
    expect(trailer).toBe('/play?coords=E@247W,337N,5.5U');
    expect(trailer).not.toContain('://');
    expect(trailer).not.toContain('voxels.com');
    expect(trailer).not.toMatch(/[a-z0-9-]+\.[a-z]{2,}/i);
  });

  test('includes the play URL when WOMPTRON_INCLUDE_URL is true', () => {
    let result = '';

    withEnv({ WOMPTRON_INCLUDE_URL: 'true' }, () => {
      const { textForPost } = require('../src/index');
      result = textForPost(sampleWomp());
    });

    // The opt-in path swaps the host-less path for the real URL, and pays 13x.
    expect(result).toBe(
      '"nice" at PIGGYBANK, by 0x889b4…57c8b\nhttps://voxels.com/play?coords=E@247W,337N,5.5U'
    );
  });
});

describe('applyPostCap', () => {
  const queueOf = (ids: number[]) => ids.map((id) => ({ ...sampleWomp(), id }));

  test('leaves the queue alone when under the cap', () => {
    const { applyPostCap } = require('../src/index');

    const queue = queueOf([1, 2, 3]);
    applyPostCap(queue);

    expect(queue).toHaveLength(3);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  test('keeps the newest N and logs what was skipped', () => {
    const queue = queueOf([80_634, 80_642, 80_643]);

    withEnv({ WOMPTRON_MAX_POSTS_PER_RUN: '2' }, () => {
      const loggerModule = require('../src/logger');
      loggerModule.logger = mockLogger;
      const { applyPostCap } = require('../src/index');
      applyPostCap(queue);
    });

    // Queue is oldest first, so the newest two survive
    expect(queue.map((w: any) => w.id)).toEqual([80_642, 80_643]);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('skipping 1')
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Estimated cost avoided: $0.015')
    );
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('Skipped womp ids: 80634')
    );
  });

  test('still honours the old WOMPTRON_MAX_TWEETS_PER_RUN name', () => {
    const queue = queueOf([1, 2, 3, 4]);

    withEnv(
      {
        WOMPTRON_MAX_POSTS_PER_RUN: undefined,
        WOMPTRON_MAX_TWEETS_PER_RUN: '1',
      },
      () => {
        const loggerModule = require('../src/logger');
        loggerModule.logger = mockLogger;
        const { applyPostCap } = require('../src/index');
        applyPostCap(queue);
      }
    );

    expect(queue.map((w: any) => w.id)).toEqual([4]);
  });
});

describe('postWomp', () => {
  test('uploads the image and posts through the v2 API', async () => {
    mockImageDownload();

    const { postWomp } = require('../src/index');
    const sent = await postWomp(sampleWomp(), mockXClient);

    expect(sent).toBe(true);
    expect(mockXClient.v2.uploadMedia).toHaveBeenCalledWith(
      Buffer.from(new TextEncoder().encode('fake_image_data')),
      { media_type: 'image/jpeg' }
    );
    expect(mockXClient.v2.tweet).toHaveBeenCalledWith({
      text: expect.stringContaining('nice'),
      media: { media_ids: ['mock_media_id_123'] },
    });
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.stringContaining('Posted womp #80643')
    );
  });

  test('reports failure instead of throwing', async () => {
    mockImageDownload();
    mockXClient.v2.uploadMedia.mockRejectedValueOnce(
      new Error('Upload failed')
    );

    const { postWomp } = require('../src/index');
    const sent = await postWomp(sampleWomp(), mockXClient);

    expect(sent).toBe(false);
    expect(mockLogger.error).toHaveBeenCalledWith(
      expect.stringContaining('Error posting womp #80643')
    );
  });
});

describe('runOnce, dedupe by stored womp id', () => {
  const mockBatch = (batch: unknown) => {
    const wompsModule = require('../src/womps');
    (wompsModule.getWomps as jest.Mock).mockResolvedValue(batch);
  };

  test('cold start seeds from the newest womp and posts nothing', async () => {
    mockBatch(recentBatch());

    const { runOnce } = require('../src/index');
    const result = await runOnce();

    expect(result.coldStart).toBe(true);
    expect(result.posted).toBe(0);
    expect(mockXClient.v2.tweet).not.toHaveBeenCalled();

    const { readState } = require('../src/state');
    expect(readState()?.lastWompId).toBe(ids[0]);
  });

  test('posts only womps newer than the stored id, oldest first', async () => {
    const { writeState } = require('../src/state');
    // Stored id is the fourth newest, so the three newer ones go out.
    writeState(ids[3]);
    mockBatch(recentBatch());
    mockImageDownload(3);

    const { runOnce } = require('../src/index');
    const result = await runOnce();

    expect(result.posted).toBe(3);
    const batch = recentBatch();
    const posted = mockXClient.v2.tweet.mock.calls.map((c: any) => c[0].text);
    // Oldest first, so the queue runs ids[2], ids[1], ids[0].
    for (const [i, id] of [ids[2], ids[1], ids[0]].entries()) {
      const womp = batch.womps.find((w: any) => w.id === id);
      expect(posted[i]).toContain(womp.author);
    }
  });

  test('posts nothing when the stored id is already the newest', async () => {
    const { writeState } = require('../src/state');
    writeState(ids[0]);
    mockBatch(recentBatch());

    const { runOnce } = require('../src/index');
    const result = await runOnce();

    expect(result.posted).toBe(0);
    expect(mockLogger.info).toHaveBeenCalledWith('No new womps');
  });

  test('a skipped schedule loses nothing: the id is what matters, not timing', async () => {
    const { writeState } = require('../src/state');
    // Stored id from several dropped runs ago. Under the old temporal dedupe
    // everything in between fell through the gap and was never posted.
    writeState(ids.at(-1) as number);
    mockBatch(recentBatch());
    mockImageDownload(ids.length - 1);

    const { runOnce } = require('../src/index');
    const result = await runOnce();

    expect(result.posted).toBe(ids.length - 1);
  });

  test('skips womps older than WOMPTRON_INTERVAL but still advances past them', async () => {
    const { writeState } = require('../src/state');
    writeState(ids.at(-1) as number);

    const stale = parse({
      success: true,
      womps: currentApiResponse.womps.map((w: any) => ({
        ...w,
        created_at: '2020-01-01T00:00:00.000Z',
      })),
    });

    let result: any;
    await new Promise<void>((resolve) => {
      withEnv({ WOMPTRON_INTERVAL: '3600' }, () => {
        const loggerModule = require('../src/logger');
        loggerModule.logger = mockLogger;
        const wompsModule = require('../src/womps');
        (wompsModule.getWomps as jest.Mock).mockResolvedValue(stale);
        const { runOnce } = require('../src/index');
        runOnce().then((r: any) => {
          result = r;
          resolve();
        });
      });
    });

    expect(result.posted).toBe(0);
    expect(result.skippedStale).toBe(ids.length - 1);

    const { readState } = require('../src/state');
    expect(readState()?.lastWompId).toBe(ids[0]);
  });

  test('leaves the stored id behind a failed post so the next run retries it', async () => {
    const { writeState, readState } = require('../src/state');
    // The whole fixture is queued, oldest first.
    writeState(ids.at(-1) as number);
    mockBatch(recentBatch());

    // First image download succeeds, second one 404s.
    mockImageDownload(1);
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
    } as any);

    const { runOnce } = require('../src/index');
    const result = await runOnce();

    expect(result.posted).toBe(1);
    expect(result.failed).toBe(1);
    // Advanced past the one that went out, and no further. Not to newestId,
    // so the one that failed is retried on the next run instead of vanishing.
    expect(readState()?.lastWompId).toBe(ids.at(-2));
  });
});

describe('runOnce, silent failure is impossible', () => {
  test('a fetch failure throws rather than looking like no new womps', async () => {
    const wompsModule = require('../src/womps');
    (wompsModule.getWomps as jest.Mock).mockRejectedValue(
      new Error('Could not fetch the womps feed after 3 attempts: ECONNRESET')
    );

    const { runOnce } = require('../src/index');

    await expect(runOnce()).rejects.toThrow(/Could not fetch/);
  });

  test('a shape change throws rather than looking like no new womps', async () => {
    const { WompsShapeError } = jest.requireActual('../src/womps');
    const wompsModule = require('../src/womps');
    (wompsModule.getWomps as jest.Mock).mockRejectedValue(
      new WompsShapeError('all 50 womps failed to parse')
    );

    const { runOnce } = require('../src/index');

    await expect(runOnce()).rejects.toThrow(/failed to parse/);
  });

  test('reports failed posts so the run can exit non-zero', async () => {
    const { writeState } = require('../src/state');
    writeState(ids[1]);
    const wompsModule = require('../src/womps');
    (wompsModule.getWomps as jest.Mock).mockResolvedValue(recentBatch());

    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
    } as any);

    const { runOnce } = require('../src/index');
    const result = await runOnce();

    expect(result.posted).toBe(0);
    expect(result.failed).toBe(1);
  });

  test('throws when the stored id is newer than anything in the feed', async () => {
    const { writeState } = require('../src/state');
    writeState(ids[0] + 1000);
    const wompsModule = require('../src/womps');
    (wompsModule.getWomps as jest.Mock).mockResolvedValue(recentBatch());

    const { runOnce } = require('../src/index');

    await expect(runOnce()).rejects.toThrow(/newer than anything in the feed/);
  });

  test('an empty feed leaves the stored id alone', async () => {
    const { writeState, readState } = require('../src/state');
    writeState(ids[0]);
    const wompsModule = require('../src/womps');
    (wompsModule.getWomps as jest.Mock).mockResolvedValue(
      parse({ success: true, womps: [] })
    );

    const { runOnce } = require('../src/index');
    const result = await runOnce();

    expect(result.posted).toBe(0);
    expect(readState()?.lastWompId).toBe(ids[0]);
  });
});

describe('state file', () => {
  test('a missing file is a cold start, not a zero', () => {
    const { readState } = require('../src/state');

    expect(readState()).toBeNull();
  });

  test('a corrupt file is a cold start, with a warning', () => {
    writeFileSync(process.env.WOMPTRON_STATE_FILE as string, 'not json');

    const { readState } = require('../src/state');

    expect(readState()).toBeNull();
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('cold start')
    );
  });

  test('round trips the id', () => {
    const { readState, writeState } = require('../src/state');

    writeState(81_179);

    expect(readState()?.lastWompId).toBe(81_179);
  });
});
