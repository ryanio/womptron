# womptron

Welcome to the repository for [@womptron](https://twitter.com/womptron)!

## Environment Variables

Create an application in the [Twitter Developer Platform](https://developer.twitter.com/) and provide:

- `TWITTER_CONSUMER_KEY` - Twitter API consumer key
- `TWITTER_CONSUMER_SECRET` - Twitter API consumer secret
- `TWITTER_ACCESS_TOKEN` - Twitter API access token
- `TWITTER_ACCESS_TOKEN_SECRET` - Twitter API access token secret

### Optional Configuration

- `WOMPTRON_INTERVAL` - Interval in seconds to check for new womps (default: 60)
- `WOMPTRON_INCLUDE_URL` - Append the Voxels play link to each post (default: `false`). See the cost note below before turning this on.
- `WOMPTRON_MAX_TWEETS_PER_RUN` - Ceiling on posts per tick (default: 5)
- `LOG_LEVEL` - Logging level: `ERROR`, `WARN`, `INFO`, or `DEBUG` (default: `INFO`)

## API cost

X bills post creation per request, and a post containing a URL is priced very
differently from one without:

| Post | Price per request |
| --- | --- |
| Without a URL | $0.015 |
| With a URL | $0.200 |

At the current womp rate (roughly 1.2 per day) that works out to about
$0.54/month with links off versus about $7.20/month with them on, a difference
of roughly 13x for the same number of posts. So the play link is off by default
and the coords go in the location text instead: a post reads
`"nice" - at PIGGYBANK (E@247W,337N,5.5U) - by 0x889b44…57c8b`, and a reader can
paste those coords into Voxels to get to the same place. Set
`WOMPTRON_INCLUDE_URL=true` if you want the link back and are fine with the bill.

`WOMPTRON_MAX_TWEETS_PER_RUN` is the other brake. The womps API returns up to 50
entries per page, so a Voxels backfill or a burst of activity could otherwise
turn into an unbounded run of billed requests. When the queue is over the cap the
bot posts the newest N, then logs how many it skipped, their ids, and the
estimated cost avoided.

Neither of these fixes the duplicate-post case: dedupe is purely time based with
no persistent state, so a restart re-posts anything from the last
`WOMPTRON_INTERVAL` seconds and each duplicate is a real charge. See the comment
in `getWomps` for details.

### Logging

Womptron uses a structured logging system with different levels:

- `ERROR` - Only error messages
- `WARN` - Warning and error messages  
- `INFO` - General information, warnings, and errors (default)
- `DEBUG` - All messages including detailed debugging information

Set `LOG_LEVEL=DEBUG` to see detailed API responses and debugging information.

## Run

`yarn start`
