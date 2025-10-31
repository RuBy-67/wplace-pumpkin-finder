import 'dotenv/config'
import { Impit } from 'impit'
import { PNG } from 'pngjs'
import fs from 'fs/promises'

const BASE_URL = 'https://backend.wplace.live/files/s0/tiles'
const API_BASE = 'https://backend.wplace.live/s0'
const TEMPLATE_PATHS = ['./pumpkin-template.png', './template2.png', './template3.png']
const PROXIES_FILE = './proxies.txt'
const STATE_FILE = './state.json'
const CONCURRENCY = 25
const RANDOM_COUNT = 100000
const COLOR_TOLERANCE = 25

const TEST_MODE = false
const TEST_X = 1617
const TEST_Y = 839

let loadedProxies = []
let currentProxyIndex = 0
const proxyQuarantine = new Map()
let NO_MATCH_COUNT = 0
let MATCH_COUNT = 0
let CACHED_TEMPLATES = null

function normalizeProxyLine(line) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) return null
  return trimmed
}

async function loadProxiesOnce() {
  if (loadedProxies.length > 0) return loadedProxies
  try {
    const text = await fs.readFile(PROXIES_FILE, 'utf8')
    loadedProxies = text.split(/\r?\n/).map(normalizeProxyLine).filter(Boolean)
    currentProxyIndex = 0
  } catch (_) {
    loadedProxies = []
  }
  return loadedProxies
}

async function ensureStateFile() {
  try {
    await fs.access(STATE_FILE)
  } catch (_) {
    await fs.writeFile(STATE_FILE, '', 'utf8')
  }
}

function isProxyUsable(idx) {
  const until = proxyQuarantine.get(idx) || 0
  return Date.now() >= until
}

function getCurrentProxy() {
  if (!loadedProxies.length) return null
  // Find first usable starting from currentProxyIndex
  for (let i = 0; i < loadedProxies.length; i++) {
    const idx = (currentProxyIndex + i) % loadedProxies.length
    if (isProxyUsable(idx)) {
      currentProxyIndex = idx
      const proxyUrl = loadedProxies[idx]
      return { url: proxyUrl, idx }
    }
  }
  return null
}

function rotateProxy() {
  if (!loadedProxies.length) return null
  currentProxyIndex = (currentProxyIndex + 1) % loadedProxies.length
  return getCurrentProxy()
}

function banProxy(idx, cooldownMs) {
  proxyQuarantine.set(idx, Date.now() + cooldownMs)
}

function pixeltoCoords(tileX, tileY, pixelX, pixelY) {
    const TILE_SIZE = 1000
    const CANONICAL_Z = 11
    const WORLD_PIXELS = TILE_SIZE * Math.pow(2, CANONICAL_Z);
    const globalX = tileX * TILE_SIZE + pixelX + 0.5;
    const globalY = tileY * TILE_SIZE + pixelY + 0.5;
    const xNorm = globalX / WORLD_PIXELS;
    const yNorm = globalY / WORLD_PIXELS;
    const lon = xNorm * 360 - 180;
    const lat = Math.atan(Math.sinh(Math.PI * (1 - 2 * yNorm))) * 180 / Math.PI;
    return { lat, lon, zoom: (CANONICAL_Z + 10) };
}

function buildTileUrl(x, y) {
  return `${BASE_URL}/${x}/${y}.png`
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

 async function fetchPng(url, retries = 5) {
    await loadProxiesOnce()
    for (let attempt = 0; attempt <= retries; attempt++) {
      let proxySel = getCurrentProxy()
      try {
        const opt = { browser: 'chrome', ignoreTlsErrors: true }
        if (proxySel) opt.proxyUrl = proxySel.url
        opt.timeout = 60000;
        const imp = new Impit(opt)
        const headers = { 
            "accept": "image/webp,*/*",
            "sec-ch-ua": "\"Chromium\";v=\"140\", \"Not=A?Brand\";v=\"24\", \"Google Chrome\";v=\"140\"",
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": "\"Windows\"",
            "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "same-site",
            "Referer": "https://wplace.live/"
          }
        const res = await imp.fetch(url, { headers: headers });
        if (res.status === 429) {
          const waitMs = 30000
          const state = { status: 'rate_limited', url, retryInMs: waitMs, proxy: proxySel?.url, ts: Date.now() }
          console.log(JSON.stringify(state))
          try { await fs.appendFile(STATE_FILE, JSON.stringify(state) + '\n') } catch (_) {}
          if (proxySel) banProxy(proxySel.idx, waitMs)
          proxySel = rotateProxy()
          if (!proxySel) await sleep(waitMs)
          continue
        }
        if (!res.ok) {
          // Return status so caller can handle 404 vs others
          return { statusCode: res.status, buffer: null }
        }
        const buf = await res.arrayBuffer()
        return { statusCode: 200, buffer: Buffer.from(buf) }
      } catch (e) {
        if (proxySel) banProxy(proxySel.idx, 10000)
        proxySel = rotateProxy()
        if (!proxySel) await sleep(1000)
        if (attempt === retries) return null
      }
    }
    return null
 }

async function checkPixelinfo(tileX, tileY, pixelX, pixelY) {
  const url = `${API_BASE}/pixel/${tileX}/${tileY}?x=${pixelX}&y=${pixelY}`
  try {
    const imp = new Impit({ browser: 'chrome', ignoreTlsErrors: true })
    const headers = {
        "accept": "*/*",
        "accept-language": "vi-VN,vi;q=0.9,fr-FR;q=0.8,fr;q=0.7,en-US;q=0.6,en;q=0.5,zh-CN;q=0.4,zh;q=0.3,fa;q=0.2",
        "priority": "u=1, i",
        "sec-ch-ua": "\"Chromium\";v=\"140\", \"Not=A?Brand\";v=\"24\", \"Google Chrome\";v=\"140\"",
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": "\"Windows\"",
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-site",
        "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
        "Referer": "https://wplace.live/"
      }
    const res = await imp.fetch(url, { headers: headers })
    if (!res.ok) return { ok: false, url }
    const json = await res.json()
    return { ok: true, url, json }
  } catch (_) {
    // console.log(_)
    return { ok: false, url }
  }
}

async function fetchRandomTile() {
  await loadProxiesOnce()
  let proxySel = getCurrentProxy()
  try {
    const opt = { browser: 'chrome', ignoreTlsErrors: true }
    if (proxySel) opt.proxyUrl = proxySel.url
    const imp = new Impit(opt)
    const url = `${API_BASE}/tile/random`
    const headers = {
      "accept": "application/json",
      "accept-language": "vi-VN,vi;q=0.9,fr-FR;q=0.8,fr;q=0.7,en-US;q=0.6,en;q=0.5,zh-CN;q=0.4,zh;q=0.3,fa;q=0.2",
      "priority": "u=1, i",
      "sec-ch-ua": "\"Chromium\";v=\"140\", \"Not=A?Brand\";v=\"24\", \"Google Chrome\";v=\"140\"",
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": "\"Windows\"",
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-site",
      "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36",
      "Referer": "https://wplace.live/"
    }
    const res = await imp.fetch(url, { headers: headers });
    if (res.status === 429) {
      const waitMs = 30000
      if (proxySel) banProxy(proxySel.idx, waitMs)
      await sleep(waitMs)
      return null
    }
    if (!res.ok) return null
    const json = await res.json()
    if (!json?.tile) return null
    const x = Number(json.tile.x)
    const y = Number(json.tile.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null
    return { x, y }
  } catch (_) {
    if (proxySel) banProxy(proxySel.idx, 10000)
    return null
  }
}

function colorDistanceSq(r1, g1, b1, r2, g2, b2) {
  const dr = r1 - r2
  const dg = g1 - g2
  const db = b1 - b2
  return dr * dr + dg * dg + db * db
}

function matchTemplate(png, template, tolerance) {
  const { width: W, height: H, data: D } = png
  const { width: w, height: h, data: T } = template
  const tolSq = tolerance * tolerance
  if (w > W || h > H) return null
  let best = null
  for (let y = 0; y <= H - h; y++) {
    for (let x = 0; x <= W - w; x++) {
      let ok = true
      let mismatches = 0
      for (let ty = 0; ty < h && ok; ty++) {
        for (let tx = 0; tx < w; tx++) {
          const tIdx = (w * ty + tx) << 2
          const ta = T[tIdx + 3]
          if (ta < 16) continue
          const tr = T[tIdx]
          const tg = T[tIdx + 1]
          const tb = T[tIdx + 2]
          const pIdx = (W * (y + ty) + (x + tx)) << 2
          const pr = D[pIdx]
          const pg = D[pIdx + 1]
          const pb = D[pIdx + 2]
          const pa = D[pIdx + 3]
          if (pa === 0) { ok = false; break }
          if (colorDistanceSq(pr, pg, pb, tr, tg, tb) > tolSq) {
            mismatches++
            if (mismatches > Math.max(1, Math.floor(w * h * 0.05))) { ok = false; break }
          }
        }
      }
      if (ok) {
        best = { pixelX: x, pixelY: y }
        return best
      }
    }
  }
  return best
}

async function loadTemplates() {
  const fsMod = await import('fs')
  const loaded = []
  for (const p of TEMPLATE_PATHS) {
    try {
      if (!p) continue
      const buf = fsMod.readFileSync(p)
      // eslint-disable-next-line no-await-in-loop
      const png = await parsePng(buf)
      loaded.push({ path: p, png })
    } catch (_) {
      // ignore missing/unreadable templates
    }
  }
  return loaded
}

async function getTemplatesCached() {
  if (CACHED_TEMPLATES && Array.isArray(CACHED_TEMPLATES) && CACHED_TEMPLATES.length) return CACHED_TEMPLATES
  CACHED_TEMPLATES = await loadTemplates()
  return CACHED_TEMPLATES
}

async function parsePng(buffer) {
  return new Promise((resolve, reject) => {
    new PNG().parse(buffer, (err, png) => {
      if (err) reject(err)
      else resolve(png)
    })
  })
}

async function processTile(tileX, tileY) {
  const url = buildTileUrl(tileX, tileY)
  // console.log(`Process tile ${tileX}_${tileY}`)
  const resp = await fetchPng(url)
  if (!resp) {
    const center = pixeltoCoords(tileX, tileY, 500, 500)
    const link = `https://wplace.live/?lat=${center.lat}&lng=${center.lon}&zoom=14.5`
    const state = { status: 'error', tileX, tileY, url, link, ts: Date.now() }
    // console.log(JSON.stringify(state))
    try { await fs.appendFile(STATE_FILE, JSON.stringify(state) + '\n') } catch (_) {}
    return null
  }
  // console.log(`HTTP ${resp.statusCode} ${url}`)
  if (resp.statusCode === 404) {
    const center = pixeltoCoords(tileX, tileY, 500, 500)
    const link = `https://wplace.live/?lat=${center.lat}&lng=${center.lon}&zoom=14.5`
    const state404 = { status: 'skip_404', tileX, tileY, url, link, ts: Date.now() }
    // console.log(JSON.stringify(state404))
    try { await fs.appendFile(STATE_FILE, JSON.stringify(state404) + '\n') } catch (_) {}
    return null
  }
  if (resp.statusCode !== 200 || !resp.buffer) {
    // Other non-OK statuses are treated as transient errors
    const center = pixeltoCoords(tileX, tileY, 500, 500)
    const link = `https://wplace.live/?lat=${center.lat}&lng=${center.lon}&zoom=14.5`
    const st = { status: 'error_http', code: resp.statusCode, tileX, tileY, url, link, ts: Date.now() }
    // console.log(JSON.stringify(st))
    try { await fs.appendFile(STATE_FILE, JSON.stringify(st) + '\n') } catch (_) {}
    return null
  }
  try {
    const png = await parsePng(resp.buffer)
    // console.log(`PNG parsed ${png.width}x${png.height} at ${tileX}_${tileY}`)
    const tmpls = await getTemplatesCached()
    if (!tmpls.length) return null
    if (!globalThis.__tmpl_info_logged) {
      // console.log(`Templates loaded: ${tmpls.map(t => t.path).join(', ')}`)
      globalThis.__tmpl_info_logged = true
    }
    for (const t of tmpls) {
      const tHit = matchTemplate(png, t.png, COLOR_TOLERANCE)
      if (tHit) {
        MATCH_COUNT++
        if (process && process.stdout && typeof process.stdout.write === 'function') {
          process.stdout.write(`\rfound: ${MATCH_COUNT} | no match: ${NO_MATCH_COUNT}`)
        }
        return { tileX, tileY, url, ...tHit, method: 'template', templatePath: t.path }
      }
    }
    NO_MATCH_COUNT++
    if (process && process.stdout && typeof process.stdout.write === 'function') {
      process.stdout.write(`\rfound: ${MATCH_COUNT} | no match: ${NO_MATCH_COUNT}`)
    }
    // no match: silencieux (ne rien logguer)
  } catch (_) {
    console.error(`processTile error ${tileX}_${tileY}:`, _?.message || String(_))
    return null
  }
  return null
}

async function run() {
  if (TEST_MODE && TEST_X !== undefined && TEST_Y !== undefined) {
    const url = buildTileUrl(TEST_X, TEST_Y)
    console.log(`Test single tile: ${url}`)
    const res = await processTile(TEST_X, TEST_Y)
    if (res) {
      const evt = await checkPixelinfo(res.tileX, res.tileY, res.pixelX, res.pixelY)
      let out = { 
        status: 'found', 
        tileX: res.tileX, 
        tileY: res.tileY, 
        pixelX: res.pixelX, 
        pixelY: res.pixelY, 
        tileUrl: res.url, 
        eventClaimNumber: null, 
        link: null, 
        ts: Date.now(),
      }
      if (evt.ok) {
        out.eventClaimNumber = evt.json.paintedBy?.eventClaimNumber
        out.paintedByName = evt.json.paintedBy?.username || evt.json.paintedBy?.name || evt.json.paintedBy?.displayName || evt.json.paintedBy?.id || null
        const coords = pixeltoCoords(res.tileX, res.tileY, res.pixelX, res.pixelY)
        out.link = `https://wplace.live/?lat=${coords.lat}&lng=${coords.lon}&zoom=14.5`
      }
      if (out.eventClaimNumber) {
        const who = out.paintedByName ? out.paintedByName : `#${out.eventClaimNumber}`
        console.log(`${out.tileX}/${out.tileY}@${out.pixelX},${out.pixelY} -> peinte par ${who} (${out.link})`)
      }
      console.log(JSON.stringify(out))
      try { await fs.appendFile(STATE_FILE, JSON.stringify(out) + '\n') } catch (_) {}
      return
    }
    console.log(JSON.stringify({ status: 'not_found', url }))
    process.exit(1)
  }

  console.log(`Random scanning count=${RANDOM_COUNT} concurrency=${CONCURRENCY}`)
  const seen = new Set()
  let processed = 0
  let lastTileUrl = null
  let lastTileLink = null
  async function worker() {
    while (true) {
      if (processed >= RANDOM_COUNT) return
      const rt = await fetchRandomTile()
      if (!rt) { await sleep(10); continue }
      const key = `${rt.x}_${rt.y}`
      if (seen.has(key)) continue
      seen.add(key)
      lastTileUrl = buildTileUrl(rt.x, rt.y)
      const center = pixeltoCoords(rt.x, rt.y, 500, 500)
      lastTileLink = `https://wplace.live/?lat=${center.lat}&lng=${center.lon}&zoom=14.5`
      processed++
      const res = await processTile(rt.x, rt.y)
      if (res) {
      const coords = pixeltoCoords(res.tileX, res.tileY, res.pixelX, res.pixelY)
      const link = `https://wplace.live/?lat=${coords.lat}&lng=${coords.lon}&zoom=14.5`
      const evt = await checkPixelinfo(res.tileX, res.tileY, res.pixelX, res.pixelY)
        const foundItem = {
          status: '-- PUMPKIN-FOUND --',
          tileX: res.tileX,
          tileY: res.tileY,
          pixelX: res.pixelX,
          pixelY: res.pixelY,
          tileUrl: res.url,
          eventClaimNumber: evt.ok ? evt.json?.paintedBy?.eventClaimNumber : undefined,
          paintedByName: evt.ok ? (evt.json?.paintedBy?.username || evt.json?.paintedBy?.name || evt.json?.paintedBy?.displayName || evt.json?.paintedBy?.id || undefined) : undefined,
          link: link,
          ts: Date.now()
        }
        // Hors TEST_MODE: ne remonter que si peinte par "Player"
        if (!TEST_MODE) {
          if (foundItem.paintedByName === 'Player' && foundItem.eventClaimNumber) {
            const who = foundItem.paintedByName ? foundItem.paintedByName : `#${foundItem.eventClaimNumber}`
            console.log(`${foundItem.tileX}/${foundItem.tileY}@${foundItem.pixelX},${foundItem.pixelY} -> peinte par ${who} (${foundItem.link})`)
            try { await fs.appendFile(STATE_FILE, JSON.stringify(foundItem) + '\n') } catch (_) {}
          }
        } else {
          // En TEST_MODE: comportement complet existant
          if (foundItem.eventClaimNumber) {
            const who = foundItem.paintedByName ? foundItem.paintedByName : `#${foundItem.eventClaimNumber}`
            console.log(`${foundItem.tileX}/${foundItem.tileY}@${foundItem.pixelX},${foundItem.pixelY} -> peinte par ${who} (${foundItem.link})`)
          }
          try { await fs.appendFile(STATE_FILE, JSON.stringify(foundItem) + '\n') } catch (_) {}
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, CONCURRENCY) }, () => worker()))
  console.log(JSON.stringify({ status: 'not_found', processed, tileUrl: lastTileUrl, link: lastTileLink }))
}

run().catch(err => {
  console.error(err?.message || String(err))
  process.exit(1)
})

