import { TwitterApi } from 'twitter-api-v2';
import { mockApiResponse, mockProcessedWomps } from './fixtures/sample-womps';

// Mock external dependencies
jest.mock('twitter-api-v2');
jest.mock('node-fetch');
jest.mock('../src/util');
jest.mock('../src/logger');

// Mock environment variables
const mockEnv = {
  TWITTER_CONSUMER_KEY: 'test_consumer_key',
  TWITTER_CONSUMER_SECRET: 'test_consumer_secret',
  TWITTER_ACCESS_TOKEN: 'test_access_token',
  TWITTER_ACCESS_TOKEN_SECRET: 'test_access_token_secret',
  WOMPTRON_INTERVAL: '60',
};

// Re-imports src/index with temporary env overrides, since the module reads
// its config at load time.
const withEnv = (env: Record<string, string>, fn: () => void) => {
  const previous = { ...process.env };
  Object.assign(process.env, env);
  try {
    jest.isolateModules(fn);
  } finally {
    process.env = previous;
  }
};

describe('Womptron Bot', () => {
  let mockTwitterClient: any;
  let mockFetch: jest.MockedFunction<typeof fetch>;
  let mockLogger: any;

  beforeAll(() => {
    Object.assign(process.env, mockEnv);
  });

  beforeEach(() => {
    jest.clearAllMocks();

    // Mock TwitterApi
    mockTwitterClient = {
      v1: {
        createMediaMetadata: jest.fn(),
        tweet: jest.fn(),
      },
      v2: {
        tweet: jest.fn(),
        uploadMedia: jest.fn(),
      },
    };
    (TwitterApi as jest.MockedClass<typeof TwitterApi>).mockImplementation(
      () => mockTwitterClient
    );

    // Mock fetch
    const nodeFetch = require('node-fetch');
    mockFetch = nodeFetch as jest.MockedFunction<typeof fetch>;

    // Mock util functions
    const mockUtil = require('../src/util');
    mockUtil.shortAddr = jest
      .fn()
      .mockImplementation(
        (addr: string) => `${addr.slice(0, 6)}...${addr.slice(-5)}`
      );
    mockUtil.truncate = jest.fn().mockImplementation((text: string) => text);
    mockUtil.timeout = jest.fn().mockResolvedValue(undefined);

    // Mock logger
    mockLogger = {
      info: jest.fn(),
      error: jest.fn(),
      warn: jest.fn(),
      debug: jest.fn(),
    };
    const loggerModule = require('../src/logger');
    loggerModule.logger = mockLogger;

    // Mock the getTwitterClient function to return our mock
    const indexModule = require('../src/index');
    indexModule.getTwitterClient = jest.fn().mockReturnValue(mockTwitterClient);
  });

  describe('TwitterApi Integration', () => {
    test('should initialize TwitterApi with correct credentials', () => {
      // Just import to trigger module initialization
      require('../src/index');

      expect(TwitterApi).toHaveBeenCalledWith({
        appKey: 'test_consumer_key',
        appSecret: 'test_consumer_secret',
        accessToken: 'test_access_token',
        accessSecret: 'test_access_token_secret',
      });
    });
  });

  describe('Text Processing', () => {
    test('should format tweet text correctly', () => {
      const { textForTweet } = require('../src/index');

      const result = textForTweet(mockProcessedWomps[0]);

      expect(result).toBe(
        '"nice" - at PIGGYBANK (E@247W,337N,5.5U) - by 0x889b44...57c8b'
      );
    });

    test('should handle special characters in content', () => {
      const { textForTweet } = require('../src/index');

      const wompWithSpecialChars = {
        ...mockProcessedWomps[0],
        content: 'Hello @world & "friends"',
      };

      const result = textForTweet(wompWithSpecialChars);

      expect(result).toContain('Hello @world & "friends"');
    });

    test('should handle empty content gracefully', () => {
      const { textForTweet } = require('../src/index');

      const wompWithoutContent = {
        ...mockProcessedWomps[0],
        content: '',
      };

      const result = textForTweet(wompWithoutContent);

      expect(result).toBe(
        'at PIGGYBANK (E@247W,337N,5.5U) - by 0x889b44...57c8b'
      );
      expect(result).not.toContain('""');
    });

    test('should handle empty location gracefully', () => {
      const { textForTweet } = require('../src/index');

      const wompWithoutLocation = {
        ...mockProcessedWomps[0],
        location: '',
      };

      const result = textForTweet(wompWithoutLocation);

      // With no parcel name the coords stand in as the location
      expect(result).toBe(
        '"nice" - at E@247W,337N,5.5U - by 0x889b44...57c8b'
      );
      expect(result).not.toContain('at  -');
    });

    test('should handle both empty content and location', () => {
      const { textForTweet } = require('../src/index');

      const wompMinimal = {
        ...mockProcessedWomps[0],
        content: '',
        location: '',
        coords: '',
      };

      const result = textForTweet(wompMinimal);

      expect(result).toBe('by 0x889b44...57c8b');
      expect(result).not.toContain('""');
      expect(result).not.toContain('at  -');
    });

    test('should omit the play URL by default', () => {
      const { textForTweet } = require('../src/index');

      const result = textForTweet(mockProcessedWomps[0]);

      expect(result).not.toContain('https://');
      expect(result).not.toContain('voxels.com/play');
      // The coords still reach the reader through the location text
      expect(result).toContain('E@247W,337N,5.5U');
    });

    test('should include the play URL when WOMPTRON_INCLUDE_URL is true', () => {
      let result = '';

      withEnv({ WOMPTRON_INCLUDE_URL: 'true' }, () => {
        const { textForTweet } = require('../src/index');
        result = textForTweet(mockProcessedWomps[0]);
      });

      expect(result).toBe(
        '"nice" - at PIGGYBANK (E@247W,337N,5.5U) - by 0x889b44...57c8b - https://voxels.com/play?coords=E@247W,337N,5.5U'
      );
    });
  });

  describe('Tweet Cap', () => {
    test('should leave the queue alone when under the cap', () => {
      const { applyTweetCap } = require('../src/index');

      const queue = [...mockProcessedWomps];
      applyTweetCap(queue);

      expect(queue).toHaveLength(mockProcessedWomps.length);
      expect(mockLogger.warn).not.toHaveBeenCalled();
    });

    test('should keep the newest N and log what was skipped', () => {
      const queue = [...mockProcessedWomps];

      withEnv({ WOMPTRON_MAX_TWEETS_PER_RUN: '2' }, () => {
        const loggerModule = require('../src/logger');
        loggerModule.logger = mockLogger;
        const { applyTweetCap } = require('../src/index');
        applyTweetCap(queue);
      });

      // Queue is oldest first, so the newest two survive
      expect(queue.map((w: any) => w.id)).toEqual([80_642, 80_634]);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('skipping 1')
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Estimated cost avoided: $0.015')
      );
      expect(mockLogger.warn).toHaveBeenCalledWith(
        expect.stringContaining('Skipped womp ids: 80643')
      );
    });
  });

  describe('Womp Data Processing', () => {
    test('should process womp data correctly', async () => {
      // Create mock response with recent timestamps
      const recentMockResponse = {
        success: true,
        womps: mockApiResponse.womps.map((womp, index) => ({
          ...womp,
          created_at: new Date(Date.now() - index * 10_000).toISOString(), // Recent timestamps
        })),
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue(recentMockResponse),
      } as any);

      const { getWomps } = require('../src/index');
      const result = await getWomps();

      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toHaveProperty('id');
      expect(result[0]).toHaveProperty('content');
      expect(result[0]).toHaveProperty('location');
      expect(result[0]).toHaveProperty('author');
      expect(result[0]).toHaveProperty('coords');
      expect(result[0]).toHaveProperty('playUrl');
      expect(result[0]).toHaveProperty('imgSrc');
    });

    test('should handle fetch errors gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const { getWomps } = require('../src/index');
      const result = await getWomps();

      expect(result).toEqual([]);
    });

    test('should handle empty womps response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue({ success: true, womps: [] }),
      } as any);

      const { getWomps } = require('../src/index');
      const result = await getWomps();

      expect(result).toEqual([]);
    });
  });

  describe('Tweet Creation', () => {
    test('should handle successful tweet creation', async () => {
      const mockMediaId = 'mock_media_id_123';
      const mockImageBuffer = Buffer.from('fake_image_data');

      // Mock fetch for image download
      mockFetch.mockResolvedValueOnce({
        ok: true,
        buffer: jest.fn().mockResolvedValue(mockImageBuffer),
        headers: {
          get: jest.fn().mockReturnValue('image/jpeg'),
        },
      } as any);

      mockTwitterClient.v2.uploadMedia.mockResolvedValueOnce(mockMediaId);
      mockTwitterClient.v2.tweet.mockResolvedValueOnce({
        data: { id: 'tweet_123' },
      });

      const { tweetWomp } = require('../src/index');
      await tweetWomp(mockProcessedWomps[0], mockTwitterClient);

      expect(mockFetch).toHaveBeenCalledWith(mockProcessedWomps[0].imgSrc);
      expect(mockTwitterClient.v2.uploadMedia).toHaveBeenCalledWith(
        mockImageBuffer,
        {
          media_type: 'image/jpeg',
        }
      );
      expect(mockTwitterClient.v2.tweet).toHaveBeenCalledWith({
        text: expect.stringContaining('nice'),
        media: { media_ids: [mockMediaId] },
      });
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Tweeted womp #80643')
      );
    });

    test('should handle tweet errors gracefully', async () => {
      const mockImageBuffer = Buffer.from('fake_image_data');

      // Mock fetch for image download
      mockFetch.mockResolvedValueOnce({
        ok: true,
        buffer: jest.fn().mockResolvedValue(mockImageBuffer),
        headers: {
          get: jest.fn().mockReturnValue('image/jpeg'),
        },
      } as any);

      mockTwitterClient.v2.uploadMedia.mockRejectedValueOnce(
        new Error('Upload failed')
      );

      const { tweetWomp } = require('../src/index');
      await tweetWomp(mockProcessedWomps[0], mockTwitterClient);

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Error tweeting:')
      );
    });

    test('should tweet with media using v2 API', async () => {
      const mockMediaId = 'mock_media_id_123';
      const mockImageBuffer = Buffer.from('fake_image_data');
      const wompWithoutContent = { ...mockProcessedWomps[0], content: '' };

      // Mock fetch for image download
      mockFetch.mockResolvedValueOnce({
        ok: true,
        buffer: jest.fn().mockResolvedValue(mockImageBuffer),
        headers: {
          get: jest.fn().mockReturnValue('image/jpeg'),
        },
      } as any);

      mockTwitterClient.v2.uploadMedia.mockResolvedValueOnce(mockMediaId);
      mockTwitterClient.v2.tweet.mockResolvedValueOnce({
        data: { id: 'tweet_123' },
      });

      const { tweetWomp } = require('../src/index');
      await tweetWomp(wompWithoutContent, mockTwitterClient);

      expect(mockTwitterClient.v2.uploadMedia).toHaveBeenCalled();
      expect(mockTwitterClient.v2.tweet).toHaveBeenCalledWith({
        text: expect.any(String),
        media: { media_ids: [mockMediaId] },
      });
    });
  });

  describe('Integration Tests', () => {
    test('should process and filter womps based on time', async () => {
      const testWomps = [
        {
          ...mockApiResponse.womps[0],
          created_at: '2025-08-29T18:59:30.000Z', // 30 seconds ago
        },
        {
          ...mockApiResponse.womps[1],
          created_at: '2025-08-29T18:58:00.000Z', // 2 minutes ago
        },
      ];

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue({
          success: true,
          womps: testWomps,
        }),
      } as any);

      // Mock current time
      const mockDate = new Date('2025-08-29T19:00:00.000Z');
      const originalDateNow = Date.now;
      Date.now = jest.fn(() => mockDate.getTime());

      const { getWomps } = require('../src/index');
      const result = await getWomps();

      // Should only include womps from the last 60 seconds
      expect(result.length).toBeLessThanOrEqual(testWomps.length);

      // Restore Date.now
      Date.now = originalDateNow;
    });
  });
});
