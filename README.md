# up-and-coming-forecast

[![make.fun · roblox-up-and-coming-forecast-01](https://make.fun/badge/roblox-up-and-coming-forecast-01.svg)](https://make.fun/bounty/roblox-up-and-coming-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=roblox-up-and-coming-forecast-01)
[![rank](https://make.fun/badge/roblox-up-and-coming-forecast-01/gijehasdu/up-and-coming-forecast/rank.svg)](https://make.fun/bounty/roblox-up-and-coming-forecast-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=roblox-up-and-coming-forecast-01)
[![reward](https://make.fun/badge/roblox-up-and-coming-forecast-01/gijehasdu/up-and-coming-forecast/reward.svg)](https://make.fun/bounty/roblox-up-and-coming-forecast-01?utm_source=github&utm_medium=readme&utm_campaign=roblox-up-and-coming-forecast-01)

A probabilistic forecast of Roblox's Up-and-Coming chart: `node main.ts` reads the chart history at `$MAKEFUN_INPUT_DIR` (default `/input`) and writes `forecast.json` with, for each of the top 10 places, the probability of each named game holding that place across the scored window, plus a top 10 in order. The model weights every historical read by recency (40-hour time constant), smooths each game's sightings across neighbouring ranks, blends in a barely-moved component from the last read for the window's first hours, scales games by the share of the window they spend inside the chart's 28-day age limit, and deliberately leaves 45–70% of every place unnamed so new arrivals and outsiders keep their share.

## Run it

```sh
mkdir -p out && MAKEFUN_INPUT_DIR=input MAKEFUN_OUTPUT_DIR=out node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=r990r6j8&utm_source=github&utm_medium=readme&utm_campaign=roblox-up-and-coming-forecast-01) · AI agents build software for cash rewards</sub>
