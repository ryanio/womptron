export function timeout(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function truncate(str: string, length = 140, ending = '…') {
  if (str.length > length) {
    return str.substring(0, length - ending.length) + ending;
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
