# womptron

Welcome to the repository for [@womptron](https://x.com/womptron)!

The bot runs as a scheduled GitHub Actions job. `.github/workflows/post.yml`
fires every 30 minutes, does one pass over the Voxels womps API, posts anything
it has not posted before, and exits. There is no long-running process and no
server. Node 22+ is the only supported runtime; the bot uses the platform's
global `fetch`.

## Environment Variables

Create an application in the [X Developer Platform](https://developer.x.com/)
and provide:

- `X_CONSUMER_KEY`
- `X_CONSUMER_SECRET`
- `X_ACCESS_TOKEN`
- `X_ACCESS_TOKEN_SECRET`

The older `TWITTER_*` names for all four are still read as a fallback, and the
`X_*` name wins where both are set. The GitHub Actions secrets on this repo are
still called `TWITTER_*`, and the workflow maps them across with
`${{ secrets.X_CONSUMER_KEY || secrets.TWITTER_CONSUMER_KEY }}` and so on, so
nothing breaks whether or not they have been migrated. To migrate, add the four
`X_*` secrets; the old ones can then be deleted at your leisure.

The npm package is still `twitter-api-v2` and its methods are still
`v2.tweet` and `v2.uploadMedia`. Those are third party and stay as they are.

### Optional Configuration

- `WOMPTRON_INTERVAL` - Staleness ceiling in seconds (default: 86400). Nothing
  older than this gets posted even if it is new to the bot. This is no longer
  the dedupe mechanism and no longer has to match the cron period; see below.
- `WOMPTRON_INCLUDE_URL` - Append the Voxels play link to each post (default:
  `false`). See the cost note below before turning this on.
- `WOMPTRON_MAX_POSTS_PER_RUN` - Ceiling on posts per run (default: 5). The old
  name `WOMPTRON_MAX_TWEETS_PER_RUN` is still read as a fallback.
- `WOMPTRON_STATE_FILE` - Where the last posted womp id is kept (default:
  `.womptron-state/last-womp-id.json`).
- `LOG_LEVEL` - `ERROR`, `WARN`, `INFO`, or `DEBUG` (default: `INFO`)

## How dedupe works

The bot remembers the last womp id it posted, in
`.womptron-state/last-womp-id.json`. Each run posts everything newer than that
id and then stores the new high-water mark. Nothing about this depends on when
the run happens.

That matters because it used to. Dedupe was purely temporal: each pass posted
womps created in the last `WOMPTRON_INTERVAL` seconds, which only works if the
schedule fires on time. GitHub's scheduled events are best effort and get
dropped under load, and the shortest intervals are dropped first. A womp created
during a skipped interval was simply never posted. That happened, which is why
this changed.

In CI the state file is carried between runs by the GitHub Actions cache
(`actions/cache/restore` before the run, `actions/cache/save` after). The cache
was picked over the alternatives because it needs no extra token, no extra
secret and no commit per post. Writing the id back to the repo would work too,
but it puts a commit on `main` every time the bot posts, and a repo variable via
`gh variable set` needs a PAT with scopes the default `GITHUB_TOKEN` does not
have.

**If the stored id is lost**, the next run treats it as a cold start: it seeds
the id from the newest womp in the feed and posts nothing. Womps created during
the gap are skipped rather than dumped onto the timeline as a backlog. That is
the deliberate trade, and it is the same thing the glyphbots mint watcher does.
The cache can be lost if GitHub evicts it (entries unused for 7 days, or under
the 10 GB per-repo limit) or if the workflow is disabled for a week. Running
every 30 minutes keeps the entry warm, so in practice this only bites after a
deliberate pause.

`WOMPTRON_INTERVAL` survives as a staleness ceiling rather than as the dedupe.
If the workflow is off for a week and then switched back on, the stored id makes
every womp from that week new, and posting a seven day old womp as news is
wrong. Anything older than the ceiling is skipped, and the stored id still
advances past it so it is not reconsidered.

A post that fails leaves the stored id behind it, so the next run retries that
womp instead of losing it, and the run exits non-zero.

## When something is broken, the run goes red

The bug that prompted this rewrite: the Voxels API changed shape, `getWomps`
threw, its own `try/catch` swallowed the error and returned `[]`, and the run
logged "No new womps" and exited 0. The bot could not post anything and every
run looked healthy.

So now:

- A fetch that fails three times, or a response that is not a womps envelope,
  or a response where every womp fails to parse, throws. The run exits non-zero
  and the Actions run goes red. Finding genuinely zero new womps still exits 0.
- A single womp that will not parse is skipped with a warning naming the field
  that is wrong, and the rest of the batch still goes out.
- A post that fails is logged as an error and the run exits non-zero.
- One flaky fetch is retried rather than reported, so a Voxels hiccup does not
  cry wolf.

## Checking the API shape

Voxels can change the feed without telling us. To see whether they have:

```
yarn check:api
```

It fetches the live feed, diffs the key set against both the parser and the
committed fixture, runs every womp through the bot's own `parseWomp`, and prints
the newest few as the bot would render them. It exits non-zero if the shape
moved and zero if it did not. An unreachable API exits zero with a clear "no
conclusion" line, because a CDN hiccup is not a schema change.

`.github/workflows/check-api.yml` runs it once a day and on any push touching
the parser or the fixtures, as a separate workflow from the posting job so it
can never stop the bot from posting.

When the shape does move:

```
yarn check:api                  # read the diff, see which field moved
# fix parseWomp / EXPECTED_WOMP_KEYS in src/womps.ts
yarn check:api:refresh          # recapture the fixture from the live feed
yarn test
```

### Fixtures

- `test/fixtures/womps-current.json` - captured from the live API. Refresh with
  `yarn check:api:refresh`, which keeps five womps and tries to include the
  cases that have bitten us before (null `author.name`, null `parcel_name` with
  `parcel_address` set, empty content).
- `test/fixtures/womps-legacy.json` - captured from the old API, before `author`
  became an object. Frozen on purpose. It is what proves a rollback on the
  Voxels side would not break us again.
- `test/fixtures/womps-malformed.json` - hand-written breakage. Every entry but
  the last must fail to parse, and the last must still be posted.

Tests select womps by the property under test rather than by hardcoded id, so a
refresh that pulls in a different sample does not cause a wave of unrelated
failures.

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
`"nice" - at PIGGYBANK (E@247W,337N,5.5U) - by 0x889b4…57c8b`, and a reader can
paste those coords into Voxels to get to the same place. Set
`WOMPTRON_INCLUDE_URL=true` if you want the link back and are fine with the bill.

`WOMPTRON_MAX_POSTS_PER_RUN` is the other brake. The womps API returns up to 50
entries per page, so a Voxels backfill or a burst of activity could otherwise
turn into an unbounded run of billed requests. When the queue is over the cap the
bot posts the newest N, then logs how many it skipped, their ids, and the
estimated cost avoided.

## Logging

- `ERROR` - Only error messages
- `WARN` - Warning and error messages
- `INFO` - General information, warnings, and errors (default)
- `DEBUG` - All messages including detailed API responses

## Run locally

Put the credentials in a `.env` file, then:

```
yarn install
yarn start
```

That does a single pass and exits, the same thing the scheduled job does. It
reads and writes `.womptron-state/last-womp-id.json` in the working directory,
so the first local run is a cold start that posts nothing.

`yarn start:dev` runs the TypeScript source directly through ts-node.
`yarn lint` runs Biome plus a typecheck. `yarn test` runs the suite.

## Layout

- `src/womps.ts` - fetching and parsing the feed. Knows nothing about X, which
  is what lets `check:api` validate against the exact parser the bot posts from.
- `src/state.ts` - the last posted womp id.
- `src/index.ts` - the X client, post text, the per-run cap, and `runOnce`.
- `src/check-api.ts` - the shape checker described above.
