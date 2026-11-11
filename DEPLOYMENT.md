# Deployment

Strike Circus 3D is a static Unity WebGL build. There is no bundler, no package
manager and no server code: `scripts/prepare-site.mjs` reshapes the export and
GitHub Actions publishes the result.

## Where it lives

| Piece | Value |
| --- | --- |
| Repository | `jd4rider/strike-circus-3d-web` (public) |
| Play URL | <https://jd4rider.github.io/strike-circus-3d-web/play/> |
| Cover page | <https://jd4rider.github.io/strike-circus-3d-web/> |
| Host | GitHub Pages, Actions source (`pages.yml`), no custom domain |
| Catalogue | `littlejoyarcade/src/data/games.ts` + a Supabase migration |
| Portal entry | <https://littlejoyarcade.site/#/game/strike-circus-3d> |

The portal embeds the `play/` URL in an iframe, so the game has to keep working
inside a nested browsing context: no custom domain, no service worker, no
`X-Frame-Options`.

## Deploy

```bash
git push origin main
gh run list --repo jd4rider/strike-circus-3d-web --limit 3
```

The workflow runs `node scripts/prepare-site.mjs`, asserts the payload is
servable (wasm magic bytes, no `.br` references, every required file present),
uploads `site/` and deploys it. Pages must have its source set to **GitHub
Actions** once:

```bash
gh api -X POST repos/jd4rider/strike-circus-3d-web/pages -f build_type=workflow
```

## Verify a deploy

```bash
curl -sI https://jd4rider.github.io/strike-circus-3d-web/play/            # 200 text/html
curl -sI https://jd4rider.github.io/strike-circus-3d-web/play/Build/WebGL.wasm
curl -s -r 0-3 https://jd4rider.github.io/strike-circus-3d-web/play/Build/WebGL.wasm | xxd -p
# expect 0061736d (\0asm)
```

A 200 is not proof the game runs: open the URL and wait for the progress bar to
disappear.

## Publishing to the catalogue

The portal reads its catalogue from the `public.games` table, falling back to
`src/data/games.ts`. The manifest in this repo is the source for that row:

```bash
cd ../littlejoyarcade
node scripts/publish-game.mjs ../strike-circus-3d-web/arcade-manifest.json
git add -A && git commit -m "Add Strike Circus 3D to the catalogue" && git push
```

`publish-game.mjs` needs `SUPABASE_DB_PASSWORD` in the environment; it writes the
row through the admin-only path. The portal push rebuilds the site itself.

## Payload notes

- The export is uncompressed and includes `Build/WebGL.data`,
  `Build/WebGL.wasm`, `Build/WebGL.framework.js` and `Build/WebGL.loader.js`.
- Pages allows 1 GB per site and 100 MB per file, so the build fits.
- Unity's loader asks for the data and wasm files with `must-revalidate`, so
  repeat visits do not re-download the payload once the browser has it cached.

## Rollback

Pages keeps the last deploy only. To roll back, revert the commit that changed
`build/WebGL/` and push:

```bash
git revert <sha> && git push
```
