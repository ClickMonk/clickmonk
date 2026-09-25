import QRCode from 'qrcode'
import { useMemo } from 'react'

const QUIET = 4

/**
 * The enrolment URI as a QR code, drawn as rectangles: no data URL and no SVG
 * string, so nothing here needs more from the content security policy than
 * the page itself does. Dark modules in the text colour on the card, with the
 * standard four-module quiet zone.
 */
export function TotpQr({ uri }: { uri: string }) {
  const { size, cells } = useMemo(() => {
    const m = QRCode.create(uri, { errorCorrectionLevel: 'M' }).modules
    const cells: [number, number][] = []
    for (let i = 0; i < m.data.length; i++)
      if (m.data[i] === 1) cells.push([i % m.size, Math.floor(i / m.size)])
    return { size: m.size, cells }
  }, [uri])
  const box = size + QUIET * 2
  return (
    <svg
      role="img"
      aria-label="QR code for your authenticator app"
      viewBox={`0 0 ${box} ${box}`}
      className="size-48 rounded-md bg-card"
      shapeRendering="crispEdges"
    >
      {cells.map(([x, y]) => (
        <rect
          key={`${x}.${y}`}
          data-module=""
          x={x + QUIET}
          y={y + QUIET}
          width={1}
          height={1}
          fill="var(--color-foreground)"
        />
      ))}
    </svg>
  )
}
