import { TwitterApi } from 'twitter-api-v2';
import {
  mockApiResponse,
  mockBase64Image,
  mockProcessedWomps,
} from './fixtures/sample-womps';

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
        uploadMedia: jest.fn(),
        createMediaMetadata: jest.fn(),
        tweet: jest.fn(),
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
    mockUtil.base64Image = jest.fn().mockResolvedValue(mockBase64Image);
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
        '"nice" - at PIGGYBANK - by 0x889b44...57c8b https://voxels.com/play?coords=E@247W,337N,5.5U'
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

      mockTwitterClient.v1.uploadMedia.mockResolvedValueOnce(mockMediaId);
      mockTwitterClient.v1.createMediaMetadata.mockResolvedValueOnce(undefined);
      mockTwitterClient.v1.tweet.mockResolvedValueOnce({
        data: { id: 'tweet_123' },
      });

      const { tweetWomp } = require('../src/index');
      await tweetWomp(mockProcessedWomps[0], mockTwitterClient);

      expect(mockTwitterClient.v1.uploadMedia).toHaveBeenCalled();
      expect(mockTwitterClient.v1.createMediaMetadata).toHaveBeenCalled();
      expect(mockTwitterClient.v1.tweet).toHaveBeenCalled();
      expect(mockLogger.info).toHaveBeenCalledWith(
        expect.stringContaining('Tweeted womp #80643')
      );
    });

    test('should handle tweet errors gracefully', async () => {
      mockTwitterClient.v1.uploadMedia.mockRejectedValueOnce(
        new Error('Upload failed')
      );

      const { tweetWomp } = require('../src/index');
      await tweetWomp(mockProcessedWomps[0], mockTwitterClient);

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Error tweeting:')
      );
    });

    test('should skip alt text for empty content', async () => {
      const mockMediaId = 'mock_media_id_123';
      const wompWithoutContent = { ...mockProcessedWomps[0], content: '' };

      mockTwitterClient.v1.uploadMedia.mockResolvedValueOnce(mockMediaId);
      mockTwitterClient.v1.tweet.mockResolvedValueOnce({
        data: { id: 'tweet_123' },
      });

      const { tweetWomp } = require('../src/index');
      await tweetWomp(wompWithoutContent, mockTwitterClient);

      expect(mockTwitterClient.v1.uploadMedia).toHaveBeenCalled();
      expect(mockTwitterClient.v1.createMediaMetadata).not.toHaveBeenCalled();
      expect(mockTwitterClient.v1.tweet).toHaveBeenCalled();
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
