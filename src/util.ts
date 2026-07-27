export function timeout(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Default length is for womp captions. A post is capped at 280 characters and
 * everything around the caption is small: the wrapping quotes, two " - "
 * separators, the location with coords (~45 at the long end) and the author
 * name (~20). That is roughly 75 characters of overhead, so 180 leaves headroom
 * even when WOMPTRON_INCLUDE_URL is on and a t.co link eats another 23.
 * The old 140 was set when every post carried a URL; there is more room now.
 */
export function truncate(str: string, length = 180, ending = '…') {
  if (str.length > length) {
    return str.slice(0, Math.max(0, length - ending.length)) + ending;
  }
  return str;
}

/**
 * Returns a shortened version of a full ethereum address
 * (e.g. 0x38a16…c7eb3)
 */
const ADDR_PREFIX_LENGTH = 7;
const ADDR_START_INDEX = 37;
const ADDR_END_INDEX = 42;

export const shortAddr = (addr: string) =>
  `${addr.slice(0, ADDR_PREFIX_LENGTH)}…${addr.slice(ADDR_START_INDEX, ADDR_END_INDEX)}`;
