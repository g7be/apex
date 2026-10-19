# Indiana — Real-World Multiplayer Property Sim

A browser-based multiplayer game set in **the real state of Indiana**, with full detail in downtown
Indianapolis. Every building is built from its actual OpenStreetMap footprint: about 1.5 million of
them statewide. You view the city from the air like a map: pan, zoom and
rotate, click any building to inspect it, open its procedurally generated floor plan, and lease it with
fictional in-game currency (₵), alongside other players.

> Map data © OpenStreetMap contributors (ODbL). **Interiors, rents and tenants are fictional.** The
> game invents floor plans from each real exterior footprint; they are not real floor plans. Rents are
> in-game currency, not real-estate prices.

## Quick start

Requirements: **Node.js 22.13+** (Node 24 LTS recommended). No native modules: SQLite comes from Node's
built-in `node:sqlite`.

```bash
npm install
npm run dev
```

Open http://localhost:5173. `npm run dev` starts both the game server (port 8787) and the Vite client
(port 5173, which proxies `/ws`, `/api` and `/world` to the server).

The full-detail downtown world is checked in under `data/world/indianapolis-downtown/`, so the game runs
without any download (downtown only).

### Whole-state data (Indiana)

The statewide map is built from a Geofabrik extract (~200 MB download, ~4–5 minutes to import, ~150 MB of
gzipped tiles; not committed to git):

```bash
curl -L -o data/raw/indiana-latest.osm.pbf https://download.geofabrik.de/north-america/us/indiana-latest.osm.pbf
npm run data:state
npm run data:build
```

`data:state` writes `data/world/indiana/` (checked in) and also refreshes the raw downtown data, which `data:build` turns into
the full-detail city tiles. Restart `npm run dev` afterward. Without state data the game still works; it just
stops at downtown. (`npm run data:fetch` is the older Overpass-based downtown download, kept as a fallback.)

### Production-style run (single port)

```bash
npm run build
npm start
```

Then open http://localhost:8787. The server serves the built client, the world tiles and the WebSocket.

### Tests

```bash
npm test
npm run typecheck
```

## Controls

The game uses an aerial map camera (no walking avatar).

| Input | Action |
| --- | --- |
| Left-drag | Pan the map (spins the globe when zoomed out past ~300 km) |
| Mouse wheel · + / − · on-screen ＋/－ | Zoom in and out (toward the cursor) |
| Right-drag | Rotate and tilt |
| W A S D / arrows | Pan (Shift = faster) |
| Q / E | Rotate |
| N · compass button | Face north |
| Home · ⌂ button | Back to Monument Circle |
| Click | Select a building |
| R | Open the floor plan of the selected building |
| Enter / T | Chat (toggle All / Nearby) |
| H | Help |
| Esc | Close panels / deselect |

## Two-browser multiplayer smoke test

1. `npm run dev`
2. **Browser A:** open http://localhost:5173, join as `Alice`.
3. **Browser B:** open http://localhost:5173/?profile=bob in another tab (or a private window / other
   browser), join as `Bob`. `?profile=` keeps a separate guest identity in the same browser.
4. Both HUDs show **2 online**. Each player appears to the other as a colored map pin with a name tag,
   placed where they are looking. Pan the map in A and watch A's pin move in B.
5. In A, click a building → **Rent building** → confirm. A's balance drops by the rent.
6. In B, the same building turns A's color (roof tint, base outline, floating sign); its panel says
   **Leased**, and B's **Rent** button is replaced by a note.
7. Chat from B (Enter) and see it in A.
8. Reload A: the lease, balance and last map position persist. Stop the server (Ctrl+C) and run `npm run dev`
   again: everything is still there (`server/data/game.db`).

`server/test/multiplayer.test.ts` automates the same checks over real WebSockets: join/leave, movement
relay, rent broadcast, simultaneous rent races, privacy, chat, and restart persistence.

## How it works

```
shared/   Deterministic core used by client AND server
  geo.ts        lat/lon → local meters (x east, y north), global z/x/y tile keys
  geometry.ts   polygon utilities (area, orientation, containment, principal axis, interior point)
  profile.ts    building classification, floors, height, roof, facade style, virtual rent
  interior.ts   procedural interiors from real footprints + door graph + wall segments
  protocol.ts   WebSocket message types
server/   Authoritative game server (Node + ws + node:sqlite)
  rentals.ts    lease rules, atomic transactions, expiry
  players.ts    persistent guest identities (token → hashed in DB)
  game.ts       sessions, movement fan-out, chat, rental intents
client/   React + Three.js (react-three-fiber) game
  world/        tile streaming, worker geometry generation, facade shader, picking
  game/         aerial map camera, player map markers
  ui/           HUD, property panel, floor-plan viewer, dialogs, chat
scripts/  fetch-osm.mjs (one-time Overpass download), build-world.ts (tiling pipeline)
data/     regions.json, world/<region>/ (checked-in static tiles), raw/ (download cache, not committed)
```

### Levels of detail (state scale)

| Camera distance | What you see | Source |
| --- | --- | --- |
| < 9 km near downtown | Full detail: window shader, doors, awnings, rooftop units, trees, sidewalks | `data/world/indianapolis-downtown` (z16) |
| < 5.5 km anywhere | Simplified buildings (exact footprints, flat-color walls, no details), local roads, parks, water | `data/world/indiana/detail` (z14) |
| 4–60 km | Secondary/tertiary roads, railways, rivers, county borders, water, village names | `indiana/mid` (z12) |
| 60 – 500 km | Real-scale globe; Indiana's roads (black), rivers and borders projected onto it | `indiana/overview` (z9) |
| 200 km – 30,000 km | Spin the whole planet: continents, oceans, lakes, black country and state/province borders. Labels: ~240 countries (down to ~300 km) and 294 states/provinces (from ~3,500 km down to ~120 km, so Indiana appears a few scroll steps in from the whole-US view). Labels are de-cluttered by zoom and overlap | `globe/landmasses.json` |

- Only tiles inside the camera's view frustum (plus a small margin) are downloaded and built; far tiles are disposed.
  three.js also skips drawing anything off-screen. Building tiles are built in Web Workers.
- Town labels are capped at the 24 most important places near and inside the view, not the whole state.
- Every tile's geometry is stored relative to its own center (with a group offset), so there is no float jitter
  hundreds of kilometers from the origin. Near/far planes, fog and the sky scale with zoom.
- Roads and borders on the map layers are constant-pixel-width lines, and labels keep a constant screen size.
- The server never loads 1.5M buildings into memory. A rent request carries the building's tile key, the server reads that
  tile from its own copy of the data (LRU-cached), and prices it there. Leases store the building's name, tile and location,
  so "My properties" can list and fly to them from anywhere.

### The globe

The world's local frame is a plane tangent to the Earth at Monument Circle. The globe is a sphere with Earth's real
radius (6,378 km), touching that plane at the origin, so Indiana sits at its true position and size. Below ~60 km
you see the flat map, on a green ground disc that follows the camera. Above that, the globe takes over, in the same
green. Zooming out, the camera's look-at point slides to Earth's center and it tilts to look straight down, so the
planet ends up centered. Past ~300 km, dragging spins the globe to anywhere on Earth. Zooming in only goes to street
level over the mapped state; elsewhere it stops at 600 km, since there is no street data there yet. Land masses come from Natural Earth (public domain), rebuilt with:

```bash
npm run data:globe
```

(reads `data/raw/naturalearth/ne_50m_land.geojson`, `ne_50m_lakes.geojson`, `ne_50m_admin_0_countries.geojson`, `ne_50m_admin_0_boundary_lines_land.geojson`,
`ne_50m_admin_1_states_provinces.geojson` and `ne_50m_admin_1_states_provinces_lines.geojson` and writes the checked-in
`data/world/globe/landmasses.json`).

### Real-world geometry

- `scripts/fetch-osm.mjs` downloads buildings, building parts, roads, paths, parks, water, parking and trees
  for the region bbox in a grid of small Overpass queries. It caches each cell and splits cells that time
  out. It runs once; gameplay never contacts Overpass or tile servers.
- `scripts/build-world.ts` assembles multipolygons (courtyards and holes are kept), attaches
  `building:part`s, finds each building's **street-facing edge** and nearest street, and splits everything
  into global Web-Mercator **z16 tiles** (`data/world/<region>/tiles/16-x-y.json`).
- Buildings keep their exact OSM footprints. Heights use OSM `height` / `building:levels` / parts when present,
  and deterministic estimates otherwise. The property panel says which source was used.

### Stable ids and seeds

Building ids are derived from OSM element ids (`osm:w123456`). Every procedural decision (facade colors,
windows, roofs, floor plans, prices) is seeded from `hash(id + generator version)`, so all players see the
same building and the same rooms. The server never sends geometry: clients generate it locally from the
same static tiles and seed.

### Procedural interiors

For each building (`shared/src/interior.ts`):

1. Rotate the real footprint into a **plan frame** aligned with its principal axis.
2. Pick a program from its class: office, residential, hotel, retail, civic, parking, house, …
3. Split the depth into **room bands and corridors** (double- or single-loaded), and add cross corridors in long buildings.
4. Place a **stair/elevator core** that fits fully inside the footprint and stacks on every floor.
5. Cut bands into cells, then **clip every cell against the real polygon** (polygon-clipping), so L-shapes,
   courtyards, triangles and angled walls work. Merge slivers into neighbors.
6. Name rooms: lobby near the street entrance, restrooms near the core, meeting rooms, offices; apartments
   subdivided into kitchen / bath / living / bedroom; hotel rooms with baths; storefronts; parking bays.
7. Connect rooms with doors (a spanning tree from the entrance that prefers corridors), plus an exterior door on
   the street-facing edge.
8. Validate: every room is inside the footprint, and no rooms overlap. Anything that fails falls back to a
   single open floor, which is always inside the building.

Ground and typical floors are generated once and reused (towers repeat floor plates), so a 48-floor tower is
as cheap as a 2-floor one. Interiors are generated only when a player inspects or enters a building.

### Rental economy (fictional currency)

- New players start with **₵25,000** (`STARTING_BALANCE`).
- Rent is deterministic: `290 × (floor area / 100 m²)^0.8 × class factor × location factor`, rounded to
  ₵50 (minimum ₵250). Location falls off with distance from Monument Circle. A small shop comes out around
  ₵500, a mid-size office around ₵2,500, and a large store around ₵10,000 per month.
- **Lease term = one in-game month = `LEASE_DURATION_HOURS` (default 24h real time)**, paid up front.
- **Renew** any time: you pay one more month, and the lease extends from its current expiry (at most 3 months prepaid).
- **End lease** returns the building to the market immediately, without a refund.
- Expired leases end automatically (checked every 5s and on every rent attempt), and the building returns to
  the market. All players are notified.
- At most `MAX_LEASES_PER_PLAYER` (default 8) leases per player.
- **Server-authoritative:** clients send only intents (`rent buildingId`). Prices come from the server's own
  catalog. Each rent runs in a `BEGIN IMMEDIATE` transaction, and a unique partial index
  (`one active lease per building`) makes double-renting impossible, even across processes. Every balance
  change is written to a ledger table.

### Multiplayer

- Each player's "position" is the point their camera is looking at; others see it as a map pin.

- Guest identity: the server issues a random token kept in `localStorage` and stores only its SHA-256 hash.
- 10 Hz position updates; the server fans out dirty states only to players within `INTEREST_RADIUS`.
- Map positions are saved every 5s and on disconnect, so you return to where you were looking.
- Global and nearby chat (`CHAT_RADIUS`), with rate limiting.
- A newer tab for the same identity replaces the older session.

### Performance and world scale

- Tile data streams by distance; tile meshes are built in a **Web Worker pool** and merged per tile (one draw
  call per material). Far tiles are disposed, and detail meshes (doors, awnings, rooftop units) and trees use
  distance LOD.
- Windows come from a shader on `MeshStandardMaterial`, so there is no per-window geometry and no textures.
- Picking maps triangle indices back to buildings through per-building vertex ranges; leased buildings are
  recolored in place.
- Static geography (`data/world`) is separate from player state (SQLite). The catalog interface on the server
  and the global tile keys are the seams for PostGIS and sharding by tile range across world servers.

## Configuration

Copy `.env.example` to `.env`. All settings are optional:

| Variable | Default | Meaning |
| --- | --- | --- |
| `GAME_PORT` | 8787 | Server HTTP/WebSocket port |
| `DB_PATH` | server/data/game.db | SQLite file |
| `REGION` / `WORLD_DIR` | indianapolis-downtown / data/world | Static world to serve |
| `STARTING_BALANCE` | 25000 | ₵ for new players |
| `LEASE_DURATION_HOURS` | 24 | Real-time length of one lease month |
| `MAX_LEASES_PER_PLAYER` | 8 | Lease cap |
| `CHAT_RADIUS` | 150 | Nearby chat radius (m) |
| `INTEREST_RADIUS` | 1500 | Player streaming radius (m) |

To reset all player data, stop the server and delete `server/data/game.db*`.

## Adding a region

Add an entry to `data/regions.json` (origin, bbox, tile zoom), then run
`node scripts/fetch-osm.mjs <region>` and `npx tsx scripts/build-world.ts <region>`, and start with
`REGION=<region>`. Tile keys are global, so regions can later be merged into one world.

## Deploying

The game has two parts: a static client (map, city tiles, globe data) and the game server
(WebSockets + SQLite). Static hosts such as Netlify can only serve the first.

**Everything on one host (simplest).** Any Node host with WebSockets and a persistent disk can run
`npm ci && npm run build && npm start`; the server also serves the built client. `render.yaml` is a
ready-made Render blueprint for this (1 GB disk at `/var/data` for the database).

**Client on Netlify, server elsewhere.** `netlify.toml` builds with `npm run build:web`, which builds
the client and copies `data/world/*` into `client/dist/world`. Deploy the server (e.g. with
`render.yaml`), then in Netlify set the environment variable `VITE_GAME_SERVER` to the server's URL
(e.g. `https://apex-game-server.onrender.com`) and redeploy.

**Solo mode.** Without `VITE_GAME_SERVER`, a client that can't reach a server at its own origin
switches to single-player: `client/src/net/soloServer.ts` runs the same lease rules in the browser
and saves the balance and leases in localStorage (per browser, no other players or chat). Add
`?solo=1` to the URL to force it.

The statewide Indiana tiles (`data/world/indiana/`, ~220 MB of `.json.gz`) are checked in, so hosted
builds include the whole state. The game server sends them with `Content-Encoding: gzip`; static hosts
send the raw gzip bytes, which the client unzips itself (`fetchJson` in `client/src/world/stateData.ts`).

## Known limitations

- The terrain is flat (downtown Indianapolis is nearly flat).
- Interiors are deliberately simple: rectangular partitions clipped to the footprint, one layout per typical floor.
  They are viewed in the floor-plan inspector (2D plan + 3D preview), not walked through.
- Statewide buildings are simplified for performance: no windows, doors or building parts. Heights come from OSM tags,
  or else seeded estimates.
- Leases outside downtown are listed in "My properties", but their map markers only appear once their tile is loaded.
- Going beyond one state means many extracts, or a planet file plus PostGIS. The tile keys and catalog interface are
  already global; the import pipeline would need to run per region and be served from object storage.
