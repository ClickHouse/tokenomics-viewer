# Native macOS menu bar client

This is a small macOS 14+ companion for the local Tokenomics service. It shows
today's and month-to-date usage in the menu bar, with subscription quota
windows, a compact provider breakdown, and a daily chart. The menu-bar label
can show today's usage, shortest-window quota use, or its reset countdown.

The native client is a renderer and lifecycle companion, not a second analytics
engine. The local Node service owns ClickHouse access, sync, calendar, and
budget policy; the Swift app consumes its versioned summary contract.

![Tokenomics menu bar client showing today's and month-to-date usage](docs/images/menu-bar-overview.png)

## Run from source

Run the repository's one-line installer first. On macOS it atomically writes
`~/Library/Application Support/Tokenomics Viewer/tokenomics-launch.json`, so
the app can start the installed `tokenomics-launch` wrapper when the configured
loopback service is offline. On launch, wake, and refresh, the app probes that
exact endpoint and starts the wrapper with `--no-open` only when no Tokenomics
service answers. It does not replace an unrelated service occupying the port,
and only **Open Dashboard** opens a browser. A source-only setup can select an
executable wrapper in **Settings → Launcher fallback**.

```sh
cd mac
swift run TokenomicsMenubar
```

Run the Swift checks from `mac/`:

```sh
swift test
swift build -c release
```
