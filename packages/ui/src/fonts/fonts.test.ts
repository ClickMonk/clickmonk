import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const DIR = import.meta.dirname

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

/**
 * Each shipped font is Adobe's own static WOFF2 build from a tagged GitHub
 * release, byte for byte — an Original Version, not a subset, so the
 * Reserved Font Name `Source` stands. Hashing pins that: a re-subset, a
 * reinstancing or any other edit changes the bytes and fails here, even
 * though the file would still open and still render.
 */
const FONTS: { file: string; sha256: string; release: string }[] = [
  {
    file: 'source-sans-3-400.woff2',
    // https://github.com/adobe-fonts/source-sans/releases/tag/3.052R — WOFF2-source-sans-3.052R.zip, WOFF2/OTF/SourceSans3-Regular.otf.woff2
    sha256: '63de0da0cc05298e2e9c6e5cef506d8454ca665f6e668a99d94f51174b9256ed',
    release: 'https://github.com/adobe-fonts/source-sans/releases/tag/3.052R',
  },
  {
    file: 'source-sans-3-500.woff2',
    // https://github.com/adobe-fonts/source-sans/releases/tag/3.052R — WOFF2-source-sans-3.052R.zip, WOFF2/OTF/SourceSans3-Medium.otf.woff2
    sha256: '8a0c505a954dea762a41cb9f299b1623902a99e1f34456015313927721e2071f',
    release: 'https://github.com/adobe-fonts/source-sans/releases/tag/3.052R',
  },
  {
    file: 'source-sans-3-600.woff2',
    // https://github.com/adobe-fonts/source-sans/releases/tag/3.052R — WOFF2-source-sans-3.052R.zip, WOFF2/OTF/SourceSans3-Semibold.otf.woff2
    sha256: 'c248b0a178c362916db7c853ed640db77f184d19a0ed9fa5591fa707d3089635',
    release: 'https://github.com/adobe-fonts/source-sans/releases/tag/3.052R',
  },
  {
    file: 'source-sans-3-700.woff2',
    // https://github.com/adobe-fonts/source-sans/releases/tag/3.052R — WOFF2-source-sans-3.052R.zip, WOFF2/OTF/SourceSans3-Bold.otf.woff2
    sha256: '12954097ebbad6749ee1c81a143d555c263420115892211529fe6f51794b8439',
    release: 'https://github.com/adobe-fonts/source-sans/releases/tag/3.052R',
  },
  {
    file: 'source-serif-4-400.woff2',
    // https://github.com/adobe-fonts/source-serif/releases/tag/4.005R — source-serif-4.005_WOFF2.zip, OTF/SourceSerif4-Regular.otf.woff2
    sha256: '42aa010dbb82d90764a28f6cc7d809a9395999b7390eb3b212028c6975e97402',
    release: 'https://github.com/adobe-fonts/source-serif/releases/tag/4.005R',
  },
  {
    file: 'source-serif-4-600.woff2',
    // https://github.com/adobe-fonts/source-serif/releases/tag/4.005R — source-serif-4.005_WOFF2.zip, OTF/SourceSerif4-Semibold.otf.woff2
    sha256: '7eff2d2fde32c42992e723eb24dcc6dc5b640ef0da97ce373cd38e0604202e30',
    release: 'https://github.com/adobe-fonts/source-serif/releases/tag/4.005R',
  },
  {
    file: 'source-code-pro-400.woff2',
    // https://github.com/adobe-fonts/source-code-pro/releases/tag/2.042R-u%2F1.062R-i%2F1.026R-vf — WOFF2-source-code-pro-2.042R-u_1.062R-i_1.026Rvf.zip, WOFF2/OTF/SourceCodePro-Regular.otf.woff2
    sha256: '23a0d7981dc90c0a8ec7d8a6ca7ee5dc439c777f3e2aabcf1009fdcf0e821b79',
    release:
      'https://github.com/adobe-fonts/source-code-pro/releases/tag/2.042R-u%2F1.062R-i%2F1.026R-vf',
  },
  {
    file: 'source-code-pro-500.woff2',
    // https://github.com/adobe-fonts/source-code-pro/releases/tag/2.042R-u%2F1.062R-i%2F1.026R-vf — WOFF2-source-code-pro-2.042R-u_1.062R-i_1.026Rvf.zip, WOFF2/OTF/SourceCodePro-Medium.otf.woff2
    sha256: '6c22ecbb3630944f0e2ac58f19a9cf23523399e8e1c12bd2100d5f6a79affea8',
    release:
      'https://github.com/adobe-fonts/source-code-pro/releases/tag/2.042R-u%2F1.062R-i%2F1.026R-vf',
  },
]

describe('the shipped fonts', () => {
  it.each(FONTS)('$file is byte-identical to its release asset', ({ file, sha256: expected }) => {
    expect(sha256(join(DIR, file))).toBe(expected)
  })
})
