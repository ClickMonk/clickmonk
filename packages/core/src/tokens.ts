import type { Device } from './link.js'

export interface TokenContext {
  clickId: string
  country: string | null
  device: Device
  slug: string
  query: URLSearchParams
}

const TOKEN = /\{(click_id|country|device|link|param:([A-Za-z0-9_.-]{1,64}))\}/g

/** Replaces destination tokens with URL-encoded values. Unknown tokens are left as written. */
export function renderDestination(template: string, ctx: TokenContext): string {
  return template.replace(TOKEN, (_match, name: string, param: string | undefined) => {
    let value: string
    if (param !== undefined) value = ctx.query.get(param) ?? ''
    else if (name === 'click_id') value = ctx.clickId
    else if (name === 'country') value = ctx.country ?? ''
    else if (name === 'device') value = ctx.device
    else value = ctx.slug
    return encodeURIComponent(value)
  })
}
