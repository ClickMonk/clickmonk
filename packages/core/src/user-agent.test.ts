import { describe, expect, it } from 'vitest'
import { isBotUserAgent, parseBrowser, parseOs } from './user-agent.js'

// Made-up but realistically shaped user-agents; the version numbers do not matter.
const UA = {
  iphoneSafari:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
  iphoneChrome:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/128.0.0.0 Mobile/15E148 Safari/604.1',
  iphoneInstagram:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 340.0.0.0.0',
  iphoneFacebook:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/470.0.0.0.0]',
  androidChrome:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36',
  androidSamsung:
    'Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/25.0 Chrome/121.0.0.0 Mobile Safari/537.36',
  androidTiktok:
    'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Mobile Safari/537.36 musical_ly_2023508030 BytedanceWebview/d8a21c6',
  androidFirefox: 'Mozilla/5.0 (Android 14; Mobile; rv:130.0) Gecko/130.0 Firefox/130.0',
  windowsChrome:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  windowsEdge:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 Edg/128.0.0.0',
  windowsOpera:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36 OPR/113.0.0.0',
  macSafari:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15',
  macFirefox: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14.5; rv:130.0) Gecko/20100101 Firefox/130.0',
  chromebook:
    'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36',
  linuxFirefox: 'Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0',
}

describe('parseOs', () => {
  it.each([
    [UA.iphoneSafari, 'ios'],
    [UA.androidChrome, 'android'],
    [UA.windowsChrome, 'windows'],
    [UA.macSafari, 'macos'],
    [UA.chromebook, 'chromeos'],
    [UA.linuxFirefox, 'linux'],
    ['curl/8.5.0', 'other'],
    ['', 'other'],
  ])('%s -> %s', (ua, want) => {
    expect(parseOs(ua)).toBe(want)
  })

  it('reads iOS before macOS, and Android before Linux', () => {
    // Both user-agents also contain the later family's marker.
    expect(UA.iphoneSafari).toContain('Mac OS X')
    expect(UA.androidChrome).toContain('Linux')
    expect(parseOs(UA.iphoneSafari)).toBe('ios')
    expect(parseOs(UA.androidChrome)).toBe('android')
  })

  it('only reads the first 512 characters', () => {
    expect(parseOs(`${'x'.repeat(600)} Windows NT 10.0`)).toBe('other')
  })
})

describe('parseBrowser', () => {
  it.each([
    [UA.iphoneSafari, 'safari'],
    [UA.iphoneChrome, 'chrome'],
    [UA.iphoneInstagram, 'instagram'],
    [UA.iphoneFacebook, 'facebook'],
    [UA.androidChrome, 'chrome'],
    [UA.androidSamsung, 'samsung'],
    [UA.androidTiktok, 'tiktok'],
    [UA.androidFirefox, 'firefox'],
    [UA.windowsChrome, 'chrome'],
    [UA.windowsEdge, 'edge'],
    [UA.windowsOpera, 'opera'],
    [UA.macSafari, 'safari'],
    [UA.macFirefox, 'firefox'],
    ['curl/8.5.0', 'other'],
    ['', 'other'],
  ])('%s -> %s', (ua, want) => {
    expect(parseBrowser(ua)).toBe(want)
  })

  it('names the Chromium-based browser, not Chrome, when both are in the user-agent', () => {
    for (const ua of [UA.windowsEdge, UA.windowsOpera, UA.androidSamsung, UA.androidTiktok]) {
      expect(ua).toContain('Chrome/')
      expect(parseBrowser(ua)).not.toBe('chrome')
    }
  })

  it('only reads the first 512 characters', () => {
    expect(parseBrowser(`${'x'.repeat(600)} Firefox/130.0`)).toBe('other')
  })
})

describe('isBotUserAgent', () => {
  it.each([
    // Product tokens only: the crawlers' own info URLs name real domains.
    'Mozilla/5.0 (compatible; Googlebot/2.1)',
    'Mozilla/5.0 (compatible; bingbot/2.0)',
    'facebookexternalhit/1.1',
    'Slackbot-LinkExpanding 1.0',
    'curl/8.5.0',
    'python-requests/2.32.3',
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/128.0.0.0 Safari/537.36',
  ])('flags %s', (ua) => {
    expect(isBotUserAgent(ua)).toBe(true)
  })

  it.each(Object.entries(UA))('does not flag a browser: %s', (_name, ua) => {
    expect(isBotUserAgent(ua)).toBe(false)
  })

  it('leaves an empty user-agent to its own signal', () => {
    expect(isBotUserAgent('')).toBe(false)
  })

  it('only reads the first 512 characters', () => {
    expect(isBotUserAgent(`${UA.windowsChrome}${' '.repeat(600)}Googlebot/2.1`)).toBe(false)
  })
})
