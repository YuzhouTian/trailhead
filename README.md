# Trailhead

**Live: https://yuzhoutian.github.io/trailhead/**

A personal, bloat-free hiking map PWA. No accounts, no paywalls, no tracking — just maps,
routes that follow real paths, and a dot showing where you are.

## Features

- **Route planner** — tap points on the map; the route snaps to actual paths/trails via the
  free [BRouter](https://brouter.de) public server (hiking profiles, distance + ascent shown).
- **GPX import/export** — load routes from any other app, export what you plan here.
- **Map layers** — OpenStreetMap, OpenTopoMap, and Ordnance Survey (Outdoor/Light), switchable
  or overlaid with an opacity slider.
- **On/off route** — live GPS position with a banner telling you how far you are from the
  planned line (red warning beyond 50 m).
- **Offline** — every tile you view is cached; the ⤓ button pre-downloads a tile corridor
  along the active route (zooms 12–16) before you leave home.

## Develop

```
npm install
npm run dev
```

## Ordnance Survey layer (optional)

1. Sign up free at https://osdatahub.os.uk (OpenData plan).
2. Add a project with the **OS Maps API**.
3. Paste the project API key into ☰ → "Ordnance Survey API key".

OSM and OpenTopoMap layers work with no key at all.

## Deploy

Already set up: pushing to `main` triggers `.github/workflows/deploy.yml`, which builds
and publishes to GitHub Pages. Nothing else to do — `git push` is the deploy.

(Pages source is set to "GitHub Actions" in repo Settings → Pages; that's a one-time setting.)

On your iPhone: open the live URL in Safari → Share → **Add to Home Screen**.
It launches full-screen like a native app.

## On the trail

1. At home (online): load or plan a route, then tap ⤓ to cache tiles along it.
2. Outside: open the app, tap ◎ — your position, the cached map, and the
   on/off-route banner all work without signal. (Route *planning* needs internet,
   since BRouter runs server-side.)

## Notes / limits

- iOS PWAs only get GPS while the app is open on screen — fine for "where am I?",
  but this app deliberately does not do background track recording.
- Public BRouter server is free and CORS-enabled; be a good citizen (it's one hobbyist request
  at a time, which is exactly what it's for). Offline tile downloads are capped at 4000 tiles
  per go to stay within OSM's tile usage policy.
