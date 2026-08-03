# Native macOS menu bar client

This is a small macOS 14+ companion for the local Tokenomics service. It shows
today's and month-to-date usage in the menu bar, with a compact provider
breakdown and daily chart.

The native client is a renderer and lifecycle companion, not a second analytics
engine. The local Node service owns ClickHouse access, sync, calendar, and
budget policy; the Swift app consumes its versioned summary contract.

![Tokenomics menu bar client showing today's and month-to-date usage](docs/images/menu-bar-overview.png)

## Run from source

Run the repository's one-line installer first. On macOS it atomically writes
`~/Library/Application Support/Tokenomics Viewer/tokenomics-launch.json`, so
the app can start the installed `tokenomics-launch` wrapper when the configured
loopback service is offline. A source-only setup can select an executable
wrapper in **Settings → Launcher fallback**.

```sh
cd mac
swift run TokenomicsMenubar
```

Run the Swift checks from `mac/`:

```sh
swift test
swift build -c release
```
