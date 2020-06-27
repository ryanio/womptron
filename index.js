const { readFileSync, writeFileSync } = require('fs');

require.extensions['.txt'] = function (module, filename) {
  module.exports = readFileSync(filename, 'utf8');
};

const Parser = require('rss-parser');
const fetch = require('node-fetch');
const Twitter = require('twitter-lite');
const FileAPI = require('file-api');

const { File, FileReader } = FileAPI;
const parser = new Parser();
let lastWompId = Number(require('./last_womp_id.txt'));

const {
  TWITTER_CONSUMER_KEY,
  TWITTER_CONSUMER_SECRET,
  ACCESS_TOKEN,
  ACCESS_TOKEN_SECRET,
} = process.env;

const truncate = (str, length = 140, ending = '…') => {
  if (str.length > length) {
    return str.substring(0, length - ending.length) + ending;
  } else {
    return str;
  }
};

const updateLastWompId = (id) => {
  lastWompId = id;
  writeFileSync('./last_womp_id.txt', id);
};

const client = new Twitter({
  consumer_key: TWITTER_CONSUMER_KEY,
  consumer_secret: TWITTER_CONSUMER_SECRET,
  access_token_key: ACCESS_TOKEN,
  access_token_secret: ACCESS_TOKEN_SECRET,
});

const uploadClient = new Twitter({
  subdomain: 'upload',
  consumer_key: TWITTER_CONSUMER_KEY,
  consumer_secret: TWITTER_CONSUMER_SECRET,
  access_token_key: ACCESS_TOKEN,
  access_token_secret: ACCESS_TOKEN_SECRET,
});

const tweetForWomp = (i) => {
  return `“${i.content}” - at ${i.location} - by ${i.author} ${i.playUrl}`;
};

const tweetWomp = async (i) => {
  try {
    // Fetch image
    const base64Image = await new Promise(async (resolve) => {
      const response = await fetch(i.imgSrc);
      const blob = await response.blob();
      const reader = new FileReader();
      reader.onload = function (ev) {
        resolve(ev.target.result);
      };
      reader.readAsDataURL(
        new File({
          name: `${i.wompId}.jpg`,
          type: 'image/jpeg',
          buffer: Buffer.from(await blob.arrayBuffer()),
        })
      );
    });

    // Upload image
    const mediaUploadResponse = await uploadClient.post('media/upload', {
      media_data: base64Image.replace(/^data:image\/jpeg;base64,/, ''),
    });

    // Add alt text
    await uploadClient.post('media/metadata/create', {
      media_id: mediaUploadResponse.media_id_string,
      alt_text: { text: i.content },
    });

    // Create tweet
    await client.post('statuses/update', {
      status: tweetForWomp(i),
      media_ids: mediaUploadResponse.media_id_string,
    });

    updateLastWompId(i.wompId);
    console.log(`Success! Tweeted womp #${i.wompId}: ${tweetForWomp(i)}`);
  } catch (error) {
    console.error(error);
  }
};

const getWomps = async () => {
  let feed = await parser.parseURL('https://www.cryptovoxels.com/womps.rss');
  let { items } = feed;

  items = items.filter((i) => Number(i.link.split('/').slice(-1)) > lastWompId);
  items = items.reverse();

  items = items.map(async (item) => {
    let { link, content: rawContent, creator, title: location } = item;

    const linkParts = link.split('/');
    const wompId = linkParts[linkParts.length - 1];
    const imgSrc = `https://js.cryptovoxels.com/api/womps/${wompId}.jpg`;

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

    return { wompId, content, location, author, playUrl, imgSrc };
  });

  return await Promise.all(items);
};

const timeout = (ms) => {
  return new Promise((resolve) => setTimeout(resolve, ms));
};

(async () => {
  const womps = await getWomps();
  for (womp of womps) {
    await tweetWomp(womp);
    await timeout(5000);
  }
})();
