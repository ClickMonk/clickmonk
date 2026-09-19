# Branding

The ClickMonk marks, colours and type, and the rules for using them. If you are adding a
header, favicon, social card or docs theme, everything you need is in
[`brand/`](brand/). Please use it rather than drawing something new.

## The files

| File | Use it for |
| --- | --- |
| `brand/lockup.svg` | Mark and wordmark together. **The default choice.** One colour, `currentColor`. |
| `brand/lockup-light.svg`, `brand/lockup-dark.svg` | The lockup in two colours, baked in. Use these where CSS cannot reach the SVG. |
| `brand/mark.svg` | The mark alone, one colour, `currentColor`. Where the name is already present. |
| `brand/mark-light.svg`, `brand/mark-dark.svg` | The mark in two colours, baked in. |
| `brand/wordmark.svg` | "ClickMonk" set as outlines, no mark, `currentColor`. |
| `brand/favicon.svg` | The mark in two colours, switching with the browser's colour scheme. |
| `brand/avatar-light.svg`, `-dark.svg`, `-accent.svg` | Square, with a background. Social profiles. |
| `brand/social-card-light.svg`, `-dark.svg` | 1280×640 preview card for links. |
| `brand/*.png` | Raster copies for places that refuse SVG: avatar and social-preview uploads, `og:image`, `apple-touch-icon`, a 32px favicon. |
| `brand/tokens.css`, `brand/tokens.json` | Every colour and type token, both modes. |
| `brand/contrast-report.txt` | The measured contrast ratio of every colour pairing. |

An SVG loaded through `<img>` gets its own document with no cascade from the host page,
so `currentColor` falls back to black and a one-colour mark disappears on a dark
background. A GitHub README is exactly this case. Pick the baked pair with `<picture>`:

```html
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="brand/lockup-dark.svg">
  <img src="brand/lockup-light.svg" alt="ClickMonk" width="220">
</picture>
```

Anywhere CSS does reach (a web page, an inlined SVG) use `lockup.svg` or `mark.svg` and
set the colour yourself.

## The mark

**The tally gate:** four upright strokes crossed by a fifth, the count of five kept by
hand. ClickMonk counts every click, and the crossing stroke is the redirect, one line
cutting across the others on its way somewhere. The uprights lean and differ slightly in
height because that is how a hand tallies. The irregularity is fixed, not random: the
mark is identical in every file.

It comes in two colour treatments:

- **Two colours (default):** ink uprights, verdigris crossing stroke.
- **One colour:** every stroke the same colour. For single-colour contexts, and on a
  verdigris background.

**Rules:**

- **Do not straighten the uprights, even out their heights, or add a sixth stroke.**
- **Only the crossing stroke ever takes the accent colour.** Never colour an upright.
- **One mark at every size.** There is no simplified small variant.
- **Minimum clear space:** one stroke width on all four sides, beyond the mark's own
  padding.
- Do not set the mark on a photograph, a gradient or a texture.
- Do not stretch, rotate, outline, add effects to, or recolour it beyond the two
  treatments above.

## Colour

Ink on vellum, with a verdigris accent.

**There is no single ClickMonk hex.** The accent is a different step of the verdigris
ramp in each mode, because no one value clears WCAG AA against both a light surface and
a dark one.

| Role | Light | Dark |
| --- | --- | --- |
| `surface` | `#F8FBFB` | `#101111` |
| `text` | `#101111` | `#EDF1F1` |
| `text-muted` | `#555D5D` | `#9CA6A7` |
| `accent` | `#006A61` | `#6EBFB5` |
| `border-interactive` | `#737D7D` | `#737D7D` |

Take values from `brand/tokens.css` or `brand/tokens.json` rather than from this table,
which is a summary. Every pairing in `brand/contrast-report.txt` carries a measured
ratio; if you introduce a new pairing, measure it, do not estimate it.

**Red is not a brand colour.** In ClickMonk, red means a blocked click or an error and
nothing else, so the accent is kept well away from it in hue. Do not use red to
represent the brand.

## Type

**Source Serif 4** for display and the wordmark, **Source Sans 3** for text and
interface, **Source Code Pro** for click IDs, URLs and code. All three are by Adobe,
under the SIL Open Font License 1.1. That licence is a requirement, not a preference:
you embed these fonts in your own deployment when you self-host, and a commercial
licence would make that your legal problem. Numbers are set with tabular figures.

The wordmark is set in Source Serif 4 Semibold and emitted as outlines, so the lockups
carry no font dependency.

## The name

**ClickMonk.** One word, two capitals. Not "Clickmonk", not "Click Monk", not
"CLICKMONK".

ClickMonk is **fair-code** or **source-available**. It is never "open source": the
Sustainable Use License is not OSI-approved, so the phrase is a factual error about the
licence rather than a matter of style. See [`LICENSE.md`](LICENSE.md).

## Using the marks yourself

You may use the ClickMonk name and marks to refer to ClickMonk: in a blog post, a talk,
a comparison, an integration listing, or a "works with ClickMonk" note. No permission
needed, and that includes writing critically about it.

Please do not use them as the identity of your own product or service, modify them and
keep calling them ClickMonk, or use them in a way that suggests ClickMonk endorses or
maintains something it does not. The Sustainable Use License covers the source; it does
not grant rights to the marks.

If you self-host and want to re-brand your own deployment, that is fine: replace the
assets. The request is only that a modified mark not travel under the ClickMonk name.

## Known limits

- **16px is workable, not comfortable.** The stroke weight was tuned against 16px and
  96px together, so neither is optimal alone. In one colour at 16px the crossing stroke
  blends into the uprights; the two-colour favicon is the one to use.
- **The wordmark is set, not drawn.** It leans on the mark to carry recognition.
- **The dark-mode accent is pale.** `#6EBFB5` clears contrast comfortably and reads
  lighter than the pigment it is named after.

## These files are generated

Everything in `brand/` is output from a build script, including the geometry and the
contrast report. **Edits made directly to these files will be overwritten on the next
rebuild.** If something needs to change, please open an issue rather than patching the
asset.
