import fetch from 'node-fetch'
import { Womp } from './index'

export async function base64Image(womp: Womp): Promise<string> {
  const response = await fetch(womp.imgSrc)
  const buf = await response.buffer()
  return buf.toString('base64')
}

export function timeout(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function truncate(str: string, length = 140, ending = '…') {
  if (str.length > length) {
    return str.substring(0, length - ending.length) + ending
  } else {
    return str
  }
}

/**
 * Returns a shortened version of a full ethereum address
 * (e.g. 0x38a16…c7eb3)
 */
export const shortAddr = (addr: string) =>
  addr.slice(0, 7) + '…' + addr.slice(37, 42)
