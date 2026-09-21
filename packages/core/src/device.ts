import type { Device } from './link.js'

export const MAX_UA_LENGTH = 512

/**
 * iOS, Android or desktop, from the user-agent. Deliberately coarse: this
 * chooses a device URL, it is not analytics. iPadOS 13+ Safari sends a
 * desktop Mac user-agent by default and is classified desktop; there is no
 * reliable way to tell from the header alone. Written in-house rather than
 * with ua-parser-js, whose v2 is AGPL.
 */
export function classifyDevice(userAgent: string | undefined): Device {
  if (!userAgent) return 'desktop'
  const ua = userAgent.slice(0, MAX_UA_LENGTH)
  if (/\b(iPhone|iPad|iPod)\b/.test(ua)) return 'ios'
  if (/\bAndroid\b/.test(ua)) return 'android'
  return 'desktop'
}
