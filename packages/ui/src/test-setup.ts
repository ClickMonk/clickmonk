import '@testing-library/jest-dom/vitest'
import { cleanup } from '@testing-library/react'
import { afterEach, beforeEach } from 'vitest'

// Testing Library cleans up after each test only when it can see a global
// afterEach, which this config does not provide. Without this, a second test
// in a file finds the first test's tree still mounted.
afterEach(() => cleanup())

// One jsdom serves a whole file, so storage is shared between its tests: the
// theme a test stored would decide what the next one sees.
beforeEach(() => {
  localStorage.clear()
  document.documentElement.removeAttribute('data-theme')
})

// jsdom has no media queries. Every test sees a light system preference.
if (!window.matchMedia) {
  window.matchMedia = (query: string) =>
    ({
      matches: false,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList
}

// jsdom declares <dialog> and implements none of it. Opening sets `open`,
// which is what the accessibility tree reads; closing removes it and fires
// `close`, which is what the modal listens for. Escape, focus and the inert
// page behind are the browser's, and are tested in the browser suite.
if (!HTMLDialogElement.prototype.showModal) {
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open')
    this.dispatchEvent(new Event('close'))
  }
}
