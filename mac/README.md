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

On launch, wake, and refresh, the app probes the configured loopback endpoint.
If Tokenomics is offline, it starts the backend with `--no-open`. It resolves the
launcher from the installer's persisted command, an explicit **Settings →
Launcher fallback**, the current source checkout when run with `swift run`, or
`~/.local/bin/tokenomics-launch`. It does not replace an unrelated service
occupying the port, and only **Open Dashboard** opens a browser.

```sh
cd mac
swift run TokenomicsMenubar
```

Run the Swift checks from `mac/`:

```sh
swift test
swift build -c release
```
