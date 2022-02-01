import fetch from 'node-fetch'
import Twitter from 'twitter-lite'
import { base64Image, timeout, truncate } from './util'

export interface Womp {
  id: number
  author: string
  location: string
  content: string
  playUrl: string
  imgSrc: string
}

const {
  TWITTER_CONSUMER_KEY,
  TWITTER_CONSUMER_SECRET,
  TWITTER_ACCESS_TOKEN,
  TWITTER_ACCESS_TOKEN_SECRET,
  DEBUG,
} = process.env

const WOMPTRON_INTERVAL = Number(process.env.WOMPTRON_INTERVAL ?? 60)

const secrets = {
  consumer_key: TWITTER_CONSUMER_KEY,
  consumer_secret: TWITTER_CONSUMER_SECRET,
  access_token_key: TWITTER_ACCESS_TOKEN,
  access_token_secret: TWITTER_ACCESS_TOKEN_SECRET,
}

const client = new Twitter(secrets)

const uploadClient = new Twitter({
  subdomain: 'upload',
  ...secrets,
})

const textForTweet = (womp: Womp) => {
  const { content, location, author, playUrl } = womp
  return `“${content}” - at ${location} - by ${author} ${playUrl}`
}

const tweetWomp = async (womp: Womp) => {
  try {
    // Fetch and upload image
    const mediaUploadResponse = await uploadClient.post('media/upload', {
      media_data: await base64Image(womp),
    })

    // Add alt text
    const { content } = womp
    if (Boolean(content)) {
      await uploadClient.post('media/metadata/create', {
        media_id: mediaUploadResponse.media_id_string,
        alt_text: { text: content },
      })
    }

    // Create tweet
    await client.post('statuses/update', {
      status: textForTweet(womp),
      media_ids: mediaUploadResponse.media_id_string,
    })

    console.log(`Womptron - Tweeted womp #${womp.id}: ${textForTweet(womp)}`)
  } catch (error) {
    console.error(`Womptron - Error tweeting: ${JSON.stringify(error)}`)
  }
}

const getWomps = async (): Promise<Womp[]> => {
  try {
    const response = await fetch(
      `https://www.cryptovoxels.com/api/womps.json?${Date.now()}`,
      { mode: 'no-cors' } as any
    )

    if (!response.ok) {
      console.error(
        `Womptron - Fetch Error - ${response.status}: ${response.statusText}`,
        DEBUG ? `DEBUG: ${JSON.stringify(await response.text())}` : ''
      )
      return
    }

    const result = await response.json()
    let { womps } = result

    if (!womps || womps.length === 0) {
      console.error(
        'Womptron - No womps returned',
        DEBUG ? `DEBUG - Result: ${JSON.stringify(result)}` : ''
      )
      return
    }

    // since WOMPTRON_INTERVAL
    womps = womps
      .filter(
        (w) =>
          new Date(w.created_at).getTime() >
          Date.now() - WOMPTRON_INTERVAL * 1000
      )
      .reverse()

    womps = womps.map(async (womp) => {
      const { id, author_name: author, image_url: imgSrc, coords } = womp
      const playUrl = `https://www.cryptovoxels.com/play?coords=${coords}`

      let content = womp.content
      let location = womp.parcel_name ?? womp.parcel_address

      // remove unsolicited mentions by removing @ symbol
      const search =
        /(^|\s|\n|\^|\(|\)|\{|\}|\[|\]|\+|\-|\\|\/|\.|\,|\|||\<|\>|\?|\'|\"|\:|\;)@(\w*)/g
      content = content.replace(search, '$1$2')
      location = location.replace(search, '$1$2')

      content = content.trim()
      content = truncate(content)

      return { id, content, location, author, playUrl, imgSrc }
    })

    return await Promise.all(womps)
  } catch (error) {
    console.error(`Womptron - Fetch Error: ${error?.message ?? error}`)
    return []
  }
}

async function main() {
  const run = async () => {
    const womps = await getWomps()
    if (!womps) return
    console.log(`Womptron - Found ${womps.length} new womps`)

    for (const [index, womp] of womps.slice(0, 5).entries()) {
      await tweetWomp(womp)

      // Wait 5s between tweets
      if (womps[index + 1]) {
        await timeout(5000)
      }
    }
  }

  run()

  const interval = setInterval(run.bind(this), WOMPTRON_INTERVAL * 1000)

  process.on('SIGINT', () => {
    console.log('Caught interrupt signal. Stopping...')
    clearInterval(interval)
    process.exit()
  })
}

main()
