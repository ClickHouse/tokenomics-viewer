# Native macOS menu bar client

This is a small macOS 14+ companion for the local Tokenomics service. It shows
today's and month-to-date usage in the menu bar, with a compact provider
breakdown and daily chart.

The client reads the existing local HTTP API. It does not read provider logs,
query the database, or store usage data.

## Screenshot

![Tokenomics menu bar client showing today's and month-to-date usage](docs/images/menu-bar-overview.png)

## Run from source

```sh
cd mac
swift run TokenomicsMenubar
```

App-managed startup requires a compatible saved launch command. Otherwise, the
client connects to an already-running local Tokenomics service.

Run the Swift checks from `mac/`:

```sh
swift test
swift build -c release
```

This PR does not create or distribute an app bundle. Packaging, signing,
notarization, and installation are separate rollout steps.

## API and presentation

The client uses the existing endpoints:

- `GET /api/sync` to identify the service and read sync state.
- `POST /api/sync` to request a refresh.
- `GET /api/summary` to render usage and cost data.

This package does not change the existing Tokenomics server, `launcher.js`,
stored configuration, or database. Extra response fields are ignored so the
client can keep working as the API grows.

For API profiles, the menu client calculates a weekday allowance from the
monthly limit, spend through yesterday, and remaining Monday-Friday days in
UTC. This is display logic only. It does not change the budget or write anything
back to Tokenomics. Subscription profiles show API-equivalent cost without a
monetary allowance.
