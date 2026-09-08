# Colour contrast verification

Calculated from `tokens.css` using the [W3C sRGB luminance definition](https://www.w3.org/TR/WCAG22/#dfn-relative-luminance). All decisions use unrounded ratios; displayed values use two decimals. This checks colour pairs, not full WCAG conformance.

| Foreground / background | Light | Dark | Minimum | Result |
|---|---:|---:|---:|---|
| --text / --bg | 13.84:1 | 15.10:1 | 4.5:1 | Pass |
| --text / --surface | 15.26:1 | 13.90:1 | 4.5:1 | Pass |
| --text / --hover | 13.57:1 | 11.67:1 | 4.5:1 | Pass |
| --text / --accent-bg | 13.37:1 | 10.20:1 | 4.5:1 | Pass |
| --text-dim / --bg | 5.71:1 | 9.03:1 | 4.5:1 | Pass |
| --text-dim / --surface | 6.29:1 | 8.31:1 | 4.5:1 | Pass |
| --text-dim / --hover | 5.60:1 | 6.98:1 | 4.5:1 | Pass |
| --text-dim / --accent-bg | 5.52:1 | 6.10:1 | 4.5:1 | Pass |
| --accent / --bg | 5.39:1 | 9.12:1 | 4.5:1 | Pass |
| --accent / --surface | 5.95:1 | 8.39:1 | 4.5:1 | Pass |
| --accent / --hover | 5.29:1 | 7.05:1 | 4.5:1 | Pass |
| --accent / --accent-bg | 5.21:1 | 6.16:1 | 4.5:1 | Pass |
| --on-accent / --accent | 5.95:1 | 8.15:1 | 4.5:1 | Pass |
| --paid / --paid-bg | 6.15:1 | 7.12:1 | 4.5:1 | Pass |
| --paid / --surface | 7.13:1 | 9.77:1 | 4.5:1 | Pass |
| --pend / --pend-bg | 5.86:1 | 7.02:1 | 4.5:1 | Pass |
| --pend / --surface | 6.64:1 | 9.54:1 | 4.5:1 | Pass |
| --stop / --stop-bg | 5.92:1 | 6.91:1 | 4.5:1 | Pass |
| --stop / --surface | 6.92:1 | 8.85:1 | 4.5:1 | Pass |
| --stop / --hover | 6.16:1 | 7.43:1 | 4.5:1 | Pass |
| --stop / --accent-bg | 6.07:1 | 6.50:1 | 4.5:1 | Pass |
| --border-str / --surface | 3.52:1 | 4.11:1 | 3:1 | Pass |
| --border-str / --bg | 3.19:1 | 4.47:1 | 3:1 | Pass |

Text requires 4.5:1. Control boundaries require 3:1. The quiet --border separator carries no state or control-boundary meaning. Focus uses --accent and exceeds 3:1 on every supported adjacent surface.
