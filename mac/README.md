# Native macOS menu bar client

This is a small macOS 14+ companion for the local Tokenomics service. It shows
today's and month-to-date usage in the menu bar, with a compact provider
breakdown and daily chart.

![Tokenomics menu bar client showing today's and month-to-date usage](docs/images/menu-bar-overview.png)

## Run from source

```sh
cd mac
swift run TokenomicsMenubar
```

Run the Swift checks from `mac/`:

```sh
swift test
swift build -c release
```
