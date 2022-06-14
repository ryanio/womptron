import fetch from 'node-fetch'
import { File, FileReader } from 'file-api'
import { Womp } from './index'

export async function base64Image(womp: Womp): Promise<string> {
  return await new Promise(async (resolve) => {
    const response = await fetch(womp.imgSrc)
    const blob = await response.blob()
    const reader = new FileReader()
    reader.onload = function (ev) {
      const base64Image = ev.target.result
      // Format to satisfy Twitter API
      const formattedBase64Image = base64Image.replace(
        /^data:image\/jpeg;base64,/,
        ''
      )
      resolve(formattedBase64Image)
    }
    reader.readAsDataURL(
      new File({
        name: `${womp.id}.jpg`,
        type: 'image/jpeg',
        buffer: Buffer.from(await (blob as any).arrayBuffer()),
      })
    )
  })
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
