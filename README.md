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
- `LOG_LEVEL` - Logging level: `ERROR`, `WARN`, `INFO`, or `DEBUG` (default: `INFO`)

### Logging

Womptron uses a structured logging system with different levels:

- `ERROR` - Only error messages
- `WARN` - Warning and error messages  
- `INFO` - General information, warnings, and errors (default)
- `DEBUG` - All messages including detailed debugging information

Set `LOG_LEVEL=DEBUG` to see detailed API responses and debugging information.

## Run

`yarn start`
