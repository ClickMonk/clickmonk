import { render, screen } from '@testing-library/react'
import QRCode from 'qrcode'
import { describe, expect, it } from 'vitest'
import { TotpQr } from './TotpQr'

const URI = 'otpauth://totp/ClickMonk:admin%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=ClickMonk'

describe('the QR code', () => {
  it('draws one rectangle per dark module, and nothing else', () => {
    const { container } = render(<TotpQr uri={URI} />)
    const modules = QRCode.create(URI, { errorCorrectionLevel: 'M' }).modules
    const dark = Array.from(modules.data).filter((m) => m === 1).length
    expect(container.querySelectorAll('rect[data-module]')).toHaveLength(dark)
    expect(container.querySelector('svg')).toHaveAttribute(
      'viewBox',
      `0 0 ${modules.size + 8} ${modules.size + 8}`,
    )
  })

  it('says what it is to a screen reader, and never shows the address it encodes', () => {
    render(<TotpQr uri={URI} />)
    expect(
      screen.getByRole('img', { name: 'QR code for your authenticator app' }),
    ).toBeInTheDocument()
    expect(document.body.textContent).not.toContain('otpauth://')
  })
})
