import type { ReactNode } from 'react'

export interface CardProps {
  children: ReactNode
  description?: string
  footer?: ReactNode
  title?: string
}

export function Card({ children, description, footer, title }: CardProps) {
  return (
    <article className="card">
      {(title || description) && (
        <header className="card__header">
          {title && <h2>{title}</h2>}
          {description && <p>{description}</p>}
        </header>
      )}
      <div className="card__content">{children}</div>
      {footer && <footer className="card__footer">{footer}</footer>}
    </article>
  )
}
