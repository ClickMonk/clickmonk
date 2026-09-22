import { isbot } from 'isbot'
import { MAX_UA_LENGTH } from './device.js'

/**
 * Operating system and browser families, for reports. Families only, no
 * versions: a version multiplies the rows a report groups by and says little
 * about where a click came from. Anything not recognised is `other`.
 *
 * The record stores these as short strings, not as a closed list, so a
 * family added here later needs no new spool record version.
 */
export type Os = 'ios' | 'android' | 'windows' | 'macos' | 'chromeos' | 'linux' | 'other'
export type Browser =
  | 'facebook'
  | 'instagram'
  | 'tiktok'
  | 'edge'
  | 'opera'
  | 'samsung'
  | 'firefox'
  | 'chrome'
  | 'safari'
  | 'other'

// Checked in order: the first match wins. iOS before macOS, because every
// iOS user-agent says "like Mac OS X"; Android before Linux, because every
// Android user-agent says "Linux".
const OS_RULES: readonly [RegExp, Os][] = [
  [/\b(iPhone|iPad|iPod)\b/, 'ios'],
  [/\bAndroid\b/, 'android'],
  [/\bWindows\b/, 'windows'],
  [/\bCrOS\b/, 'chromeos'],
  [/\bMacintosh\b|\bMac OS X\b/, 'macos'],
  [/\bLinux\b/, 'linux'],
]

// In-app browsers first: they embed a Chrome or Safari engine and name it in
// the user-agent too. Then the browsers built on Chromium that also say
// "Chrome/", then Chrome, and Safari last, because nearly every browser's
// user-agent also says "Safari/".
const BROWSER_RULES: readonly [RegExp, Browser][] = [
  [/\bFBAN\/|\bFBAV\/|\bFB_IAB\//, 'facebook'],
  [/\bInstagram\b/, 'instagram'],
  [/\bmusical_ly\b|\bBytedanceWebview\b|\bTikTok\b/, 'tiktok'],
  [/\bEdg(e|A|iOS)?\//, 'edge'],
  [/\bOPR\/|\bOPiOS\/|\bOpera\b/, 'opera'],
  [/\bSamsungBrowser\//, 'samsung'],
  [/\bFirefox\/|\bFxiOS\//, 'firefox'],
  [/\bChrome\/|\bCriOS\//, 'chrome'],
  [/\bVersion\/[\d.]+.*\bSafari\//, 'safari'],
]

function firstMatch<T extends string>(rules: readonly [RegExp, T][], ua: string): T | 'other' {
  for (const [re, value] of rules) if (re.test(ua)) return value
  return 'other'
}

/** Reads at most the first 512 characters, like every other user-agent check. */
export function parseOs(userAgent: string): Os {
  return firstMatch(OS_RULES, userAgent.slice(0, MAX_UA_LENGTH))
}

/** Reads at most the first 512 characters. */
export function parseBrowser(userAgent: string): Browser {
  return firstMatch(BROWSER_RULES, userAgent.slice(0, MAX_UA_LENGTH))
}

/**
 * A user-agent that declares a crawler, a monitoring service, an HTTP
 * library or a headless browser. The pattern list is the `isbot` package's
 * (Unlicense). It does not call an empty user-agent a bot: a missing
 * user-agent is its own signal.
 */
export function isBotUserAgent(userAgent: string): boolean {
  return isbot(userAgent.slice(0, MAX_UA_LENGTH))
}
