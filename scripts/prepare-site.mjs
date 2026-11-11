#!/usr/bin/env node
/*
 * Turn the Unity export into a static site GitHub Pages can actually serve.
 *
 * Two things in the stock Unity template do not survive contact with Pages:
 *
 *  - Compression. A Brotli export needs `Content-Encoding: br`, which Pages
 *    cannot send, so the loader would die before the first frame. Any `.br`
 *    payload is expanded and `index.html` pointed at the plain names.
 *  - Layout. An export can ship either its own responsive layout or the stock
 *    template, which pins a fixed pixel play area on desktop and stretches the
 *    canvas across the whole viewport on phones. When the export already sizes
 *    itself (the current one fits a portrait 9:16 play area to the viewport and
 *    letterboxes it in landscape) it is left untouched; when it does not, both
 *    branches are replaced with one fit-to-screen rule that keeps the canvas
 *    aspect ratio, letterboxes, and centres it.
 *
 *   node scripts/prepare-site.mjs
 *
 * `build/WebGL/` is the untouched Unity export. `site/` is generated and not
 * committed; CI rebuilds it on every push.
 */
import { brotliDecompressSync } from 'node:zlib'
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const source = join(root, 'build/WebGL')
const site = join(root, 'site')
const play = join(site, 'play')
const publicDir = join(root, 'public')

/** Must match the public.games row and the manifest. */
const GAME_ID = 'strike-circus-3d'

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

const LANDING = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Strike Circus 3D</title>
    <meta http-equiv="refresh" content="0;url=./play/">
    <style>
      html, body { margin: 0; height: 100%; }
      body {
        display: grid; place-items: center; background: #101828; color: #e8eefb;
        font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
      }
      main { text-align: center; padding: 24px; }
      a { color: #7dd3fc; }
    </style>
  </head>
  <body>
    <main>
      <h1>Strike Circus 3D</h1>
      <p><a href="./play/">Play</a></p>
    </main>
  </body>
</html>
`

/** `WebGL.data.br` -> `WebGL.data` (path only, the extension comes off). */
function plainPath(path) {
  return path.slice(0, -'.br'.length)
}

/** Index just past the brace that closes the block opened at `from`. */
function matchBrace(text, from) {
  let depth = 0
  for (let i = from; i < text.length; i += 1) {
    if (text[i] === '{') depth += 1
    else if (text[i] === '}') {
      depth -= 1
      if (depth === 0) return i + 1
    }
  }
  throw new Error('unbalanced braces in the Unity template')
}

/** One fit-to-screen rule for every device, replacing both template branches. */
function fitScript(width, height) {
  return `        // The play area is a fixed pixel size in the Unity template; scale it to
        // whatever screen it is opened on so the whole board stays visible and
        // nothing is stretched. Injected by scripts/prepare-site.mjs.
        var fitToWindow = function () {
          var aspect = ${width} / ${height};
          var width = Math.min(window.innerWidth, window.innerHeight * aspect);
          var height = width / aspect;
          fullscreenContainer.style.width = Math.floor(width) + "px";
          fullscreenContainer.style.height = Math.floor(height) + "px";
        };
        document.querySelector("#unity-container").className = "unity-desktop";
        fitToWindow();
        window.addEventListener("resize", fitToWindow);
        window.addEventListener("orientationchange", fitToWindow);`
}

async function main() {
  const buildInfo = await stat(source).catch(() => null)
  if (!buildInfo?.isDirectory()) throw new Error(`missing Unity export at ${source}`)

  await rm(site, { recursive: true, force: true })
  await mkdir(play, { recursive: true })
  for (const entry of ['index.html', 'Build', 'StreamingAssets', 'TemplateData']) {
    const from = join(source, entry)
    if (!(await stat(from).catch(() => null))) continue
    await cp(from, join(play, entry), { recursive: true })
  }

  // 1. Brotli payload -> plain files the browser can read without a header.
  //    An export that already ships uncompressed files is left alone.
  const buildDir = join(play, 'Build')
  const entries = await readdir(buildDir)
  const packedFiles = entries.filter((entry) => entry.endsWith('.br'))
  let compressed = 0
  let expanded = 0
  for (const entry of packedFiles) {
    const packed = join(buildDir, entry)
    const bytes = await readFile(packed)
    const plain = brotliDecompressSync(bytes)
    compressed += bytes.byteLength
    expanded += plain.byteLength
    await writeFile(plainPath(packed), plain)
    await rm(packed)
  }
  if (packedFiles.length === 0) {
    console.log('payload is already uncompressed: nothing to expand')
  } else {
    console.log(`decompressed ${packedFiles.length} files, ${mb(compressed)} -> ${mb(expanded)}`)
  }

  const indexPath = join(play, 'index.html')
  let html = await readFile(indexPath, 'utf8')

  // 2. Point the loader at the uncompressed names.
  const before = (html.match(/\.br"/g) ?? []).length
  if (before !== packedFiles.length) {
    throw new Error(`index.html references ${before} .br files but the build has ${packedFiles.length}`)
  }
  html = html.replaceAll('.br"', '"')

  // 3. Layout. An export that already sizes its own play area is used exactly as
  //    Unity generated it: re-fitting a portrait game to the old template's
  //    canvas size would squeeze it back into a landscape box.
  const hasOwnLayout = html.includes('PORTRAIT_ASPECT') || html.includes('layoutCanvas') ||
    html.includes('fitStage')
  let playArea = "the export's own responsive layout"
  if (!hasOwnLayout) {
    // 3a. Stock template: read the canvas size out of the export so a re-export
    //     at a different resolution needs no code change.
    const canvas = html.match(/<canvas id="unity-canvas"[^>]*width="(\d+)"[^>]*height="(\d+)"/)
    if (!canvas) throw new Error('could not read the canvas size from index.html')
    const [, width, height] = canvas.map(Number)

    // 3b. Replace the whole `if (mobile) {...} else {...}` layout branch.
    const marker = 'if (/iPhone|iPad|iPod|Android/i.test(navigator.userAgent))'
    const start = html.indexOf(marker)
    if (start === -1) throw new Error('Unity template changed: could not find the user-agent layout branch')
    const mobileEnd = matchBrace(html, html.indexOf('{', start))
    const elseBlock = /^\s*else\s*\{/.exec(html.slice(mobileEnd))
    if (!elseBlock) throw new Error('Unity template changed: the layout branch has no else block')
    const end = matchBrace(html, mobileEnd + elseBlock[0].length - 1)
    html = html.slice(0, start) + fitScript(width, height) + html.slice(end)
    if (!html.includes('fitToWindow')) throw new Error('canvas fit patch did not apply')
    if (html.includes('navigator.userAgent')) throw new Error('user-agent layout branch survived the patch')
    playArea = `${width}x${height} play area`
  } else {
    console.log('export ships its own responsive layout: no canvas patch applied')
  }

  // 4. Page furniture: a title worth sharing, a viewport that phones honour, and
  //    the game's own colour behind the letterbox bars instead of white.
  html = html.replace(/<title>[^<]*<\/title>/, '<title>Strike Circus 3D</title>')
  if (!html.includes('viewport-fit=cover')) {
    html = html.replace(
      '</head>',
      `  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
    <style>
      html, body { margin: 0; height: 100%; background: #0b0618; overscroll-behavior: none; }
      #unity-canvas { touch-action: none; }
      @media (max-width: 700px) { #unity-footer { display: none; } }
    </style>
  </head>`,
    )
  }
  // 4b. The arcade account layer. The drop-in client is copied next to the build and
  //     its tag injected, so the game shares the signed-in session of the portal it is
  //     embedded in. A Unity re-export replaces index.html, so this is also the step
  //     that has to fail loudly if the tag goes missing.
  const clientFrom = join(publicDir, 'arcade-client.js')
  const clientInfo = await stat(clientFrom).catch(() => null)
  if (!clientInfo?.isFile()) throw new Error('missing public/arcade-client.js')
  await cp(clientFrom, join(play, 'arcade-client.js'))

  const accountTag = `<script src="./arcade-client.js" data-game-id="${GAME_ID}"></script>`
  if (!html.includes(accountTag)) {
    if (!html.includes('</body>')) throw new Error('index.html has no </body> to inject the account tag before')
    html = html.replace('</body>', `  ${accountTag}\n  </body>`)
    // The client pins its account pill to the bottom-left, exactly where the Unity
    // footer's logo sits; lift it clear of the footer.
    if (!html.includes('[data-lja-client]')) {
      html = html.replace(
        '</head>',
        `  <style>
      [data-lja-client] { bottom: 46px !important; }
    </style>
  </head>`,
      )
    }
  }
  if (!html.includes(accountTag)) throw new Error('site/play/index.html is missing the account tag')


  // 4c. Unity save bridge. Unity keeps saves in its own `/idbfs` filesystem, so the
  //     page mirrors it for the arcade client. A Unity re-export replaces
  //     index.html, so this is the step that fails loudly if the tag goes missing.
  const unityFrom = join(publicDir, 'arcade-unity.js')
  const unityInfo = await stat(unityFrom).catch(() => null)
  if (!unityInfo?.isFile()) throw new Error('missing public/arcade-unity.js')
  await cp(unityFrom, join(play, 'arcade-unity.js'))

  const unityTag = `<script src="./arcade-unity.js" data-game-id="${GAME_ID}"></script>`
  if (!html.includes(unityTag)) {
    const factory = html.indexOf('createUnityInstance(')
    const templateTag = factory === -1 ? -1 : html.lastIndexOf('<script', factory)
    if (templateTag === -1) throw new Error('index.html has no Unity template script to put the save bridge before')
    html = html.slice(0, templateTag) + unityTag + '\n  ' + html.slice(templateTag)
  }
  if (!html.includes(unityTag)) throw new Error('site/play/index.html is missing the Unity save bridge')
  if (html.indexOf(unityTag) > html.indexOf('createUnityInstance(')) {
    throw new Error('the Unity save bridge must load before the template script')
  }

  // 4d. Persist every write. Unity leaves `autoSyncPersistentDataPath` off by default,
  //     so PlayerPrefs and files under persistentDataPath only reach IndexedDB when the
  //     game flushes by hand - the bridge would then see an empty save for the whole
  //     session and the cloud row would never fill. With it on, Unity syncs on every
  //     file change, so progress is in `/idbfs` for the next poll and survives a hard
  //     close. A Unity re-export replaces index.html, so fail loudly if it goes missing.
  const autoSync = /^\s*config\.autoSyncPersistentDataPath\s*=\s*true/m
  if (!autoSync.test(html)) {
    const factoryAt = html.indexOf('createUnityInstance(')
    if (factoryAt === -1) throw new Error('index.html has no createUnityInstance call to put the autosync flag before')
    const lineStart = html.lastIndexOf('\n', factoryAt) + 1
    html = html.slice(0, lineStart) + '        config.autoSyncPersistentDataPath = true;\n' + html.slice(lineStart)
  }
  if (!autoSync.test(html)) throw new Error('site/play/index.html is missing the persistent-data autosync flag')

  await writeFile(indexPath, html)

  await writeFile(join(site, 'index.html'), LANDING)

  // 5. Fail loudly here rather than in a player's console.
  const required = ['Build/WebGL.loader.js', 'Build/WebGL.data', 'Build/WebGL.wasm', 'Build/WebGL.framework.js']
  for (const file of required) {
    const info = await stat(join(play, file)).catch(() => null)
    if (!info?.isFile()) throw new Error(`site/play/${file} is missing from the build`)
  }
  const loader = await readFile(join(play, 'index.html'), 'utf8')
  if (loader.includes('.br"')) throw new Error('index.html still references compressed payload')
  if (hasOwnLayout) {
    if (!loader.includes('layoutCanvas') && !loader.includes('fitStage'))
      throw new Error('site/play/index.html lost the responsive layout')
  } else if (!loader.includes('fitToWindow')) {
    throw new Error('site/play/index.html lost the fit patch')
  }
  console.log(`site/ is ready: site/play/ serves the Unity build (${playArea})`)
}

main().catch((error) => {
  console.error(`prepare-site failed: ${error.message}`)
  process.exit(1)
})

export { plainPath }
