const { readFileSync, writeFileSync } = require('fs');
const { File, FileReader } = require('file-api');
const fetch = require('node-fetch');
const Parser = require('rss-parser');
const Twitter = require('twitter-lite');

require.extensions['.txt'] = function (module, filename) {
  module.exports = readFileSync(filename, 'utf8');
};

let lastWompId = Number(require('./last_womp_id.txt'));

const updateLastWomp = (womp) => {
  const { id } = womp;
  lastWompId = id;
  writeFileSync('./last_womp_id.txt', id);
};

const secrets = {
  consumer_key: process.env.TWITTER_CONSUMER_KEY,
  consumer_secret: process.env.TWITTER_CONSUMER_SECRET,
  access_token_key: process.env.ACCESS_TOKEN,
  access_token_secret: process.env.ACCESS_TOKEN_SECRET,
};

const client = new Twitter(secrets);

const uploadClient = new Twitter({
  subdomain: 'upload',
  ...secrets,
});

const textForTweet = (womp) => {
  const { content, location, author, playUrl } = womp;
  return `“${content}” - at ${location} - by ${author} ${playUrl}`;
};

const base64Image = async (womp) => {
  return await new Promise(async (resolve) => {
    const response = await fetch(womp.imgSrc);
    const blob = await response.blob();
    const reader = new FileReader();
    reader.onload = function (ev) {
      const base64Image = ev.target.result;
      // Format to satisfy Twitter API
      const formattedBase64Image = base64Image.replace(
        /^data:image\/jpeg;base64,/,
        ''
      );
      resolve(formattedBase64Image);
    };
    reader.readAsDataURL(
      new File({
        name: `${womp.id}.jpg`,
        type: 'image/jpeg',
        buffer: Buffer.from(await blob.arrayBuffer()),
      })
    );
  });
};

const tweetWomp = async (womp) => {
  try {
    // Fetch and upload image
    const mediaUploadResponse = await uploadClient.post('media/upload', {
      media_data: await base64Image(womp),
    });

    // Add alt text
    const { content } = womp;
    if (content && content !== '') {
      await uploadClient.post('media/metadata/create', {
        media_id: mediaUploadResponse.media_id_string,
        alt_text: { text: content },
      });
    }

    // Create tweet
    await client.post('statuses/update', {
      status: textForTweet(womp),
      media_ids: mediaUploadResponse.media_id_string,
    });

    console.log(`Tweeted womp #${womp.id}: ${textForTweet(womp)}`);
  } catch (error) {
    console.error(error);
  }
  updateLastWomp(womp);
};

const truncate = (str, length = 140, ending = '…') => {
  if (str.length > length) {
    return str.substring(0, length - ending.length) + ending;
  } else {
    return str;
  }
};

const getWomps = async () => {
  const parser = new Parser();
  const feed = await parser.parseURL('https://www.cryptovoxels.com/womps.rss');
  let { items } = feed;

  items = items.filter((i) => Number(i.link.split('/').slice(-1)) > lastWompId);
  items = items.reverse();

  items = items.map(async (item) => {
    let { link, content: rawContent, creator, title: location } = item;

    const linkParts = link.split('/');
    const id = linkParts[linkParts.length - 1];
    const imgSrc = `https://js.cryptovoxels.com/api/womps/${id}.jpg`;

    const coords = rawContent.match(/coords=(.+?)\'/)[1];
    const playUrl = `https://www.cryptovoxels.com/play?coords=${coords}`;

    let content = rawContent.match(/<\/b>([\s\S]*?)<b>/)[1];
    content = content.trim();
    content = truncate(content);

    const response = await fetch(
      `https://www.cryptovoxels.com/api/avatars/${creator}.json`,
      { mode: 'no-cors' }
    );
    const data = await response.json();
    const author = data.avatar && data.avatar.name ? data.avatar.name : creator;

    return { id, content, location, author, playUrl, imgSrc };
  });

  return await Promise.all(items);
};

const timeout = (ms) => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

(async () => {
  const womps = await getWomps();
  console.log(`Found ${womps.length} new womps!`);
  for (womp of womps) {
    await tweetWomp(womp);
    await timeout(7000);
  }
})();
