// Applies the stored theme before first paint, so a dark choice does not flash
// light for a frame. The key is the one ThemeToggle writes. Guarded, because a
// browser that refuses storage throws on access, and a theme is not worth a
// blank page.
try {
  var t = localStorage.getItem('cm-theme')
  if (t === 'light' || t === 'dark') document.documentElement.setAttribute('data-theme', t)
} catch (e) {}
