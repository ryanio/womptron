import { writeFileSync } from 'fs'
import fetch from 'node-fetch'
import Parser from 'rss-parser'
import Twitter from 'twitter-lite'
import { base64Image, timeout, truncate } from './util'
import meta from './meta.json'

export interface Womp {
  id: number
  author: string
  location: string
  content: string
  playUrl: string
  imgSrc: string
}

const updateLastWomp = (womp: Womp) => {
  meta.lastWompId = womp.id
  if (womp.content !== '' && !meta.lastWompContents.includes(womp.content)) {
    meta.lastWompContents.push(womp.content)
  }
  if (meta.lastWompContents.length > 10) {
    meta.lastWompContents = meta.lastWompContents.slice(1)
  }
  writeFileSync('./meta.json', JSON.stringify(meta))
}

const secrets = {
  consumer_key: process.env.TWITTER_CONSUMER_KEY,
  consumer_secret: process.env.TWITTER_CONSUMER_SECRET,
  access_token_key: process.env.ACCESS_TOKEN,
  access_token_secret: process.env.ACCESS_TOKEN_SECRET
}

const client = new Twitter(secrets)

const uploadClient = new Twitter({
  subdomain: 'upload',
  ...secrets
})

const textForTweet = (womp: Womp) => {
  const { content, location, author, playUrl } = womp
  return `“${content}” - at ${location} - by ${author} ${playUrl}`
}

const authorBanList = [
  'hashnews.eth', // reason: excessive spamming of duplicate content
  'DawnXue' // alias of above
]

const tweetWomp = async (womp: Womp) => {
  if (womp.content !== '' && meta.lastWompContents.includes(womp.content)) {
    console.log(`Skipping womp #${womp.id}: duplicate content`)
    updateLastWomp(womp)
    return
  }
  if (authorBanList.includes(womp.author)) {
    console.log(`Skipping womp #${womp.id}: author banned`)
    updateLastWomp(womp)
    return
  }
  try {
    // Fetch and upload image
    const mediaUploadResponse = await uploadClient.post('media/upload', {
      media_data: await base64Image(womp)
    })

    // Add alt text
    const { content } = womp
    if (Boolean(content)) {
      await uploadClient.post('media/metadata/create', {
        media_id: mediaUploadResponse.media_id_string,
        alt_text: { text: content }
      })
    }

    // Create tweet
    await client.post('statuses/update', {
      status: textForTweet(womp),
      media_ids: mediaUploadResponse.media_id_string
    })

    console.log(`Tweeted womp #${womp.id}: ${textForTweet(womp)}`)
  } catch (error) {
    console.error(error)
  }

  updateLastWomp(womp)
}

const getWomps = async (): Promise<Womp[]> => {
  const parser = new Parser()
  const feed = await parser.parseURL('https://www.cryptovoxels.com/womps.rss')
  let { items } = feed

  // since lastWompId
  items = items
    .filter(i => Number(i.link.split('/').slice(-1)) > meta.lastWompId)
    .reverse()

  items = items.map(async item => {
    let { link, content: rawContent, creator, title: location } = item

    const linkParts = link.split('/')
    const id = Number(linkParts[linkParts.length - 1])

    const imgSrc = rawContent.match(/<img.*?src=(.*?) /)[1]

    const coords = rawContent.match(/coords=(.+?)\'/)[1]
    const playUrl = `https://www.cryptovoxels.com/play?coords=${coords}`

    let content = rawContent.match(/<\/b>([\s\S]*?)<b>/)[1]

    // remove unsoliicted mentions by removing @ symbol
    content = content.replace(/(^|\s|\n)@(\w*)/, '$1')
    location = location.replace(/(^|\s|\n)@(\w*)/, '$1')

    content = content.trim()
    content = truncate(content)

    const response = await fetch(
      `https://www.cryptovoxels.com/api/avatars/${creator}.json`,
      { mode: 'no-cors' }
    )
    const data = await response.json()
    const author: string =
      data.avatar && data.avatar.name ? data.avatar.name : creator

    const womp = { id, content, location, author, playUrl, imgSrc }
    return womp
  })

  const womps = (await Promise.all(items)) as Womp[]
  return womps
}

;(async () => {
  console.log(`~~ womptron ~~`)

  const womps = await getWomps()

  console.log(`Found ${womps.length} new womps.`)

  for (const [index, womp] of womps.slice(0, 3).entries()) {
    await tweetWomp(womp)

    // Wait 7s between tweets
    if (womps[index + 1]) {
      await timeout(7000)
    }
  }
})()
