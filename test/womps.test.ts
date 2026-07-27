import {
  asRecent,
  currentApiResponse,
  findWomp,
  idsNewestFirst,
  legacyApiResponse,
  malformedApiResponse,
} from './fixtures';

jest.mock('../src/logger');

// Real truncate and shortAddr, but no real sleeping between fetch retries.
jest.mock('../src/util', () => ({
  ...jest.requireActual('../src/util'),
  timeout: jest.fn().mockResolvedValue(undefined),
}));

const mockLogger = {
  debug: jest.fn(),
  error: jest.fn(),
  info: jest.fn(),
  warn: jest.fn(),
};

let mockFetch: jest.MockedFunction<typeof fetch>;

beforeEach(() => {
  jest.clearAllMocks();
  mockFetch = jest.fn() as jest.MockedFunction<typeof fetch>;
  global.fetch = mockFetch;
  const loggerModule = require('../src/logger');
  loggerModule.logger = mockLogger;
});

const jsonResponse = (body: unknown) =>
  ({ ok: true, json: jest.fn().mockResolvedValue(body) }) as any;

describe('parseWomp, current API shape', () => {
  test('parses every womp in the captured live fixture', () => {
    const { parseWompsPayload } = require('../src/womps');

    const batch = parseWompsPayload(currentApiResponse);

    expect(batch.failures).toEqual([]);
    expect(batch.womps).toHaveLength(currentApiResponse.womps.length);
    expect(batch.total).toBe(currentApiResponse.womps.length);
  });

  test('uses author.name as the display name', () => {
    const { parseWomp } = require('../src/womps');

    const raw = findWomp(
      currentApiResponse,
      'author.name is a string',
      (w) => typeof w.author?.name === 'string' && w.author.name.length > 0
    );

    expect(parseWomp(raw).author).toBe(raw.author.name);
  });

  test('falls back to a short author.owner when author.name is null', () => {
    const { parseWomp } = require('../src/womps');
    const { shortAddr } = jest.requireActual('../src/util');

    // The exact regression. author.name is null on plenty of real womps, and
    // the wallet now lives at author.owner rather than at author.
    const raw = findWomp(
      currentApiResponse,
      'author.name is null',
      (w) => w.author?.name === null
    );

    expect(parseWomp(raw).author).toBe(shortAddr(raw.author.owner));
    expect(parseWomp(raw).author).toMatch(/^0x\w{5}…\w{5}$/);
  });

  test('falls back to parcel_address when parcel_name is null', () => {
    const { parseWomp } = require('../src/womps');

    const raw = findWomp(
      currentApiResponse,
      'parcel_name null with parcel_address set',
      (w) => w.parcel_name === null && typeof w.parcel_address === 'string'
    );

    expect(parseWomp(raw).location).toBe(raw.parcel_address);
  });

  test('accepts empty content', () => {
    const { parseWomp } = require('../src/womps');

    const raw = findWomp(
      currentApiResponse,
      'empty content',
      (w) => w.content === '' || w.content === null
    );

    expect(parseWomp(raw).content).toBe('');
    expect(parseWomp(raw).author).toBeTruthy();
  });

  test('never throws addr.slice is not a function on the new author object', () => {
    const { parseWompsPayload } = require('../src/womps');

    // author stopped being a string and the old code handed the object
    // straight to shortAddr, which threw inside getWomps, was swallowed by its
    // own try/catch, and turned into a cheerful "No new womps".
    expect(() => parseWompsPayload(currentApiResponse)).not.toThrow();
  });

  test('sorts newest id first', () => {
    const { parseWompsPayload } = require('../src/womps');

    const batch = parseWompsPayload(currentApiResponse);
    const newest = idsNewestFirst(currentApiResponse)[0];

    expect(batch.womps.map((w: any) => w.id)).toEqual(
      idsNewestFirst(currentApiResponse)
    );
    expect(batch.newestId).toBe(newest);
  });
});

describe('parseWomp, legacy API shape', () => {
  test('still parses the pre-2026 shape so a rollback does not break us', () => {
    const { parseWompsPayload } = require('../src/womps');

    const batch = parseWompsPayload(legacyApiResponse);

    expect(batch.failures).toEqual([]);
    expect(batch.womps).toHaveLength(3);
  });

  test('uses the top-level author_name when it is set', () => {
    const { parseWomp } = require('../src/womps');

    const womp = parseWomp(
      legacyApiResponse.womps.find((w: any) => w.id === 80_634)
    );

    expect(womp.author).toBe('AdoraTokyo');
  });

  test('shortens the author string when author_name is null', () => {
    const { parseWomp } = require('../src/womps');

    const womp = parseWomp(
      legacyApiResponse.womps.find((w: any) => w.id === 80_643)
    );

    expect(womp.author).toBe('0x889b4…57c8b');
    expect(womp.location).toBe('PIGGYBANK');
  });
});

describe('parseWomp, malformed entries', () => {
  test('skips the bad ones and keeps the good one', () => {
    const { parseWompsPayload } = require('../src/womps');

    const batch = parseWompsPayload(malformedApiResponse);

    // One bad womp must not take down the batch.
    expect(batch.womps).toHaveLength(1);
    expect(batch.womps[0].id).toBe(99_005);
    expect(batch.womps[0].author).toBe('survivor');
    expect(batch.failures.length).toBe(malformedApiResponse.womps.length - 1);
  });

  test('names the field that is wrong in each failure', () => {
    const { parseWompsPayload } = require('../src/womps');

    const reasons = parseWompsPayload(malformedApiResponse)
      .failures.map((f: any) => f.reason)
      .join('\n');

    expect(reasons).toContain('id is missing or not a number');
    expect(reasons).toContain('author is neither an object nor');
    expect(reasons).toContain('neither a name nor an owner');
    expect(reasons).toContain('image_url is missing');
    expect(reasons).toContain('created_at is missing or unparseable');
  });

  test('throws when every womp fails, because that is a shape change', () => {
    const { parseWompsPayload, WompsShapeError } = require('../src/womps');

    const allBad = {
      success: true,
      womps: malformedApiResponse.womps.filter((w: any) => w?.id !== 99_005),
    };

    expect(() => parseWompsPayload(allBad)).toThrow(WompsShapeError);
    expect(() => parseWompsPayload(allBad)).toThrow(/API shape changed/);
  });

  test('throws when the envelope has no womps array', () => {
    const { parseWompsPayload, WompsShapeError } = require('../src/womps');

    expect(() => parseWompsPayload({ success: true, data: [] })).toThrow(
      WompsShapeError
    );
    expect(() => parseWompsPayload('not json at all')).toThrow(WompsShapeError);
  });

  test('an empty feed is not a shape change', () => {
    const { parseWompsPayload } = require('../src/womps');

    const batch = parseWompsPayload({ success: true, womps: [] });

    expect(batch.womps).toEqual([]);
    expect(batch.newestId).toBeNull();
  });
});

describe('getWomps, failure is never silent', () => {
  test('throws instead of returning nothing when the fetch keeps failing', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'));

    const { getWomps } = require('../src/womps');

    await expect(getWomps()).rejects.toThrow(/Could not fetch the womps feed/);
  });

  test('throws instead of returning nothing on a persistent HTTP error', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: jest.fn().mockResolvedValue('boom'),
    } as any);

    const { getWomps } = require('../src/womps');

    await expect(getWomps()).rejects.toThrow(/HTTP 500/);
  });

  test('recovers from one flaky attempt rather than going red', async () => {
    mockFetch
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValueOnce(jsonResponse(asRecent(currentApiResponse)));

    const { getWomps } = require('../src/womps');
    const batch = await getWomps();

    expect(batch.womps).toHaveLength(currentApiResponse.womps.length);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  test('throws when the body parses but is not a womps response', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ error: 'nope' }));

    const { getWomps, WompsShapeError } = require('../src/womps');

    await expect(getWomps()).rejects.toThrow(WompsShapeError);
  });

  test('warns loudly about womps it had to skip', async () => {
    mockFetch.mockResolvedValue(jsonResponse(asRecent(malformedApiResponse)));

    const { getWomps } = require('../src/womps');
    await getWomps();

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.stringContaining('would not parse')
    );
  });
});
