import { describe, expect, it } from 'vitest'
import { renderDestination } from './tokens.js'

const ctx = {
  clickId: '01920000-0000-7000-8000-000000000001',
  country: 'DE',
  device: 'android' as const,
  slug: 'spring',
  query: new URLSearchParams('sub1=email&weird=a b&x=1'),
}

describe('renderDestination', () => {
  it('replaces every known token', () => {
    expect(
      renderDestination(
        'https://example.com/?cid={click_id}&c={country}&d={device}&l={link}&s={param:sub1}',
        ctx,
      ),
    ).toBe(
      'https://example.com/?cid=01920000-0000-7000-8000-000000000001&c=DE&d=android&l=spring&s=email',
    )
  })

  it('URL-encodes values', () => {
    expect(renderDestination('https://example.com/?w={param:weird}', ctx)).toBe(
      'https://example.com/?w=a%20b',
    )
  })

  it('renders an absent parameter and an unknown country as empty', () => {
    expect(
      renderDestination('https://example.com/?s={param:nope}&c={country}', {
        ...ctx,
        country: null,
      }),
    ).toBe('https://example.com/?s=&c=')
  })

  it('leaves unknown tokens untouched', () => {
    expect(renderDestination('https://example.com/{nope}', ctx)).toBe('https://example.com/{nope}')
  })
})
