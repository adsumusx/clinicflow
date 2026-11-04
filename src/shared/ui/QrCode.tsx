import { useEffect, useState } from 'react'
import QRCode from 'qrcode'

export interface QrCodeProps {
  value: string
  size?: number
  title?: string
  className?: string
}

export function QrCode({ value, size = 180, title, className }: QrCodeProps) {
  const [dataUrl, setDataUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let active = true
    if (!value) {
      setDataUrl(null)
      return
    }

    QRCode.toDataURL(value, {
      width: size,
      margin: 2,
      color: {
        dark: '#1e293b',
        light: '#ffffff',
      },
    })
      .then((url) => {
        if (active) {
          setDataUrl(url)
          setError(null)
        }
      })
      .catch((err) => {
        if (active) {
          setError(err instanceof Error ? err.message : 'Não foi possível gerar o QR Code.')
        }
      })

    return () => {
      active = false
    }
  }, [value, size])

  if (error) {
    return <div className="qrcode-error" role="alert">{error}</div>
  }

  if (!dataUrl) {
    return (
      <div
        className="qrcode-placeholder"
        style={{
          width: size,
          height: size,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: 'var(--color-surface-container, #f1f5f9)',
          borderRadius: 'var(--radius-md, 8px)',
          color: 'var(--color-on-surface-variant, #64748b)',
          fontSize: '0.875rem',
        }}
      >
        Gerando QR Code…
      </div>
    )
  }

  return (
    <figure
      className={`qrcode-wrapper ${className ?? ''}`}
      style={{
        display: 'inline-flex',
        flexDirection: 'column',
        alignItems: 'center',
        margin: 0,
        gap: '0.5rem',
      }}
    >
      <img
        src={dataUrl}
        alt={title ?? `QR Code para ${value}`}
        width={size}
        height={size}
        style={{
          display: 'block',
          borderRadius: 'var(--radius-md, 8px)',
          border: '1px solid var(--color-outline-variant, #cbd5e1)',
          background: '#ffffff',
          boxShadow: 'var(--shadow-sm, 0 1px 2px rgba(0,0,0,0.05))',
        }}
      />
      {title && (
        <figcaption
          style={{
            fontSize: '0.75rem',
            color: 'var(--color-on-surface-variant, #64748b)',
            textAlign: 'center',
          }}
        >
          {title}
        </figcaption>
      )}
    </figure>
  )
}
