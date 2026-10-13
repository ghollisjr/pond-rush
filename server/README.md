# The game server

A ~200-line HTTP API that holds rooms and refuses anything the engine would
refuse. It shares `src/pond-engine.ts`, `src/rules.ts` and `src/room.ts` with
the browser, so there is exactly one implementation of the rules.

## Running it locally

```bash
npm run server          # http://localhost:8787
curl localhost:8787/api/health
```

Needs [Deno](https://deno.com). Nothing else — no install step, no bundler.
Deno runs the TypeScript directly, the same way `npm test` does under node.

## Deploying it

The server is a plain `Request -> Response` function (`src/server-api.ts`).
`server/main.ts` is the only Deno-specific file, and all it supplies is
storage, a clock and randomness. Moving to another host means replacing that
one file.

To put it on Deno Deploy:

1. Sign in at <https://dash.deno.com> with the GitHub account that owns this
   repository.
2. Create a project and link it to `ghollisjr/pond-rush`.
3. Set the entry point to `server/main.ts`.
4. Set the environment variable `ALLOW_ORIGIN`. It takes a comma-separated
   list, and you almost certainly want two:

   ```
   https://ghollisjr.github.io, http://localhost:8000
   ```

   The server echoes back whichever of those asked, so the published page and
   a local dev page can both reach it. Leave it unset and any origin is
   answered — fine while testing, sloppy for a deployment.

   Check it took effect:

   ```bash
   curl -sI -H 'origin: https://ghollisjr.github.io' \
     https://YOUR-SERVER/api/health | grep -i access-control-allow-origin
   ```

   If that prints `*`, the variable is not reaching the deployment.

It redeploys on every push to `main`. You get a URL like
`https://pond-rush.deno.dev` — that is what the page needs to be told about.

Check the current free-tier limits yourself rather than trusting this file;
they change, and this game's traffic is far below any of them.

## The protocol

Polling, not sockets. The game is turn-based, so nobody notices two seconds,
and every response carries the move-log position — which makes reconnecting
identical to a normal fetch.

| Method | Path                       | Does                                     |
| ------ | -------------------------- | ---------------------------------------- |
| POST   | `/api/rooms`               | make a room; returns its code             |
| POST   | `/api/rooms/:id/join`      | take a seat; returns your private token   |
| GET    | `/api/rooms/:id?since=N`   | the room, plus moves after N              |
| POST   | `/api/rooms/:id/move`      | play a move; validated by `applyMove`     |
| GET    | `/api/health`              | liveness                                  |
| GET    | `/`                        | a status page, so opening it in a browser looks alive rather than broken |

A move is sent as an index into `legalMoves`, with `expect` naming the move
count the client believes it is at. Both matter:

- **An index cannot describe an illegal move.** The worst a client can send is
  a number that is not in range, which is rejected by counting. There is no
  parsing of untrusted move objects anywhere.
- **`expect` is compare-and-swap.** Two clients acting on a stale board would
  otherwise both submit something legal *there* and the second would land
  somewhere it was never meant to.

Tokens are 24 random bytes, are never included in a room view, and are the
only thing identifying a player. There are no accounts. Anyone holding a room
code can take a free seat, which is the right level of ceremony for a game
among friends and the wrong one for anything else.
