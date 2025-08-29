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

  beforeEach(() => {
    // Reset all mocks
    jest.clearAllMocks();

    // Mock environment variables
    Object.assign(process.env, mockEnv);

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
    mockFetch = require('node-fetch') as jest.MockedFunction<typeof fetch>;

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
    require('../src/logger').logger = mockLogger;
  });

  describe('TwitterApi Integration', () => {
    test('should initialize TwitterApi with correct credentials', () => {
      // Import after mocks are set up
      require('../src/index');

      expect(TwitterApi).toHaveBeenCalledWith({
        appKey: 'test_consumer_key',
        appSecret: 'test_consumer_secret',
        accessToken: 'test_access_token',
        accessSecret: 'test_access_token_secret',
      });
    });
  });

  describe('Womp Data Processing', () => {
    test('should correctly process womp data from API response', async () => {
      // Mock fetch to return our test data
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue(mockApiResponse),
      } as any);

      // Import and get the function after mocks are set up
      const { getWomps } = await import('../src/index');

      // Set current time to make interval calculation predictable
      const mockDate = new Date('2025-08-29T19:00:00.000Z');
      jest.spyOn(global, 'Date').mockImplementation(() => mockDate as any);
      Date.now = jest.fn(() => mockDate.getTime());

      const result = await getWomps();

      expect(result).toHaveLength(3);
      expect(result[0]).toMatchObject({
        id: 80_643,
        content: 'nice',
        location: 'PIGGYBANK',
        author: '0x889b44...57c8b',
        playUrl: 'https://voxels.com/play?coords=E@247W,337N,5.5U',
      });
    });

    test('should handle author_name fallback correctly', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue(mockApiResponse),
      } as any);

      const { getWomps } = await import('../src/index');

      const mockDate = new Date('2025-08-29T19:00:00.000Z');
      Date.now = jest.fn(() => mockDate.getTime());

      const result = await getWomps();

      // First womp should use shortened address
      expect(result[0].author).toBe('0x889b44...57c8b');

      // Third womp should use author_name
      expect(result[2].author).toBe('AdoraTokyo');
    });

    test('should handle fetch errors gracefully', async () => {
      mockFetch.mockRejectedValueOnce(new Error('Network error'));

      const { getWomps } = await import('../src/index');

      const result = await getWomps();

      expect(result).toEqual([]);
    });

    test('should handle empty womps response', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue({ success: true, womps: [] }),
      } as any);

      const { getWomps } = await import('../src/index');

      const result = await getWomps();

      expect(result).toEqual([]);
    });
  });

  describe('Tweet Creation', () => {
    test('should create tweet with media upload', async () => {
      const mockMediaId = 'mock_media_id_123';

      mockTwitterClient.v1.uploadMedia.mockResolvedValueOnce(mockMediaId);
      mockTwitterClient.v1.createMediaMetadata.mockResolvedValueOnce(
        undefined as any
      );
      mockTwitterClient.v1.tweet.mockResolvedValueOnce({
        data: { id: 'tweet_123' },
      } as any);

      const { tweetWomp } = await import('../src/index');

      await tweetWomp(mockProcessedWomps[0]);

      // Check media upload
      expect(mockTwitterClient.v1.uploadMedia).toHaveBeenCalledWith(
        expect.any(Buffer)
      );

      // Check metadata creation
      expect(mockTwitterClient.v1.createMediaMetadata).toHaveBeenCalledWith(
        mockMediaId,
        { alt_text: { text: 'nice' } }
      );

      // Check tweet creation
      expect(mockTwitterClient.v1.tweet).toHaveBeenCalledWith(
        '"nice" - at PIGGYBANK - by 0x889b44...57c8b https://voxels.com/play?coords=E@247W,337N,5.5U',
        { media_ids: mockMediaId }
      );
    });

    test('should skip alt text for empty content', async () => {
      const mockMediaId = 'mock_media_id_123';
      const wompWithoutContent = { ...mockProcessedWomps[0], content: '' };

      mockTwitterClient.v1.uploadMedia.mockResolvedValueOnce(mockMediaId);
      mockTwitterClient.v1.tweet.mockResolvedValueOnce({
        data: { id: 'tweet_123' },
      } as any);

      const { tweetWomp } = await import('../src/index');

      await tweetWomp(wompWithoutContent);

      expect(mockTwitterClient.v1.uploadMedia).toHaveBeenCalled();
      expect(mockTwitterClient.v1.createMediaMetadata).not.toHaveBeenCalled();
      expect(mockTwitterClient.v1.tweet).toHaveBeenCalled();
    });

    test('should handle tweet errors gracefully', async () => {
      mockTwitterClient.v1.uploadMedia.mockRejectedValueOnce(
        new Error('Upload failed')
      );

      const { tweetWomp } = await import('../src/index');

      await tweetWomp(mockProcessedWomps[0]);

      expect(mockLogger.error).toHaveBeenCalledWith(
        expect.stringContaining('Error tweeting:')
      );
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

  describe('Time-based Filtering', () => {
    test('should filter womps by time interval', async () => {
      const oldWomp = {
        ...mockApiResponse.womps[0],
        created_at: '2025-08-29T17:00:00.000Z', // 2 hours ago
      };

      const recentWomp = {
        ...mockApiResponse.womps[1],
        created_at: '2025-08-29T18:55:00.000Z', // 5 minutes ago
      };

      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: jest.fn().mockResolvedValue({
          success: true,
          womps: [oldWomp, recentWomp],
        }),
      } as any);

      // Mock current time
      const mockDate = new Date('2025-08-29T19:00:00.000Z');
      Date.now = jest.fn(() => mockDate.getTime());

      const { getWomps } = await import('../src/index');

      const result = await getWomps();

      // Should only return the recent womp (within 60 second interval)
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe(recentWomp.id);
    });
  });
});
