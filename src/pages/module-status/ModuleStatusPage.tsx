import { Button, Card, StatusBadge } from '@/shared/ui'
import './ModuleStatusPage.css'

export interface ModuleStatusPageProps {
  description: string
  features: string[]
  milestone: string
  onNavigate: (destination: 'agenda' | 'dashboard') => void
  primaryDestination: 'agenda' | 'dashboard'
  primaryLabel: string
  title: string
}

export function ModuleStatusPage({
  description,
  features,
  milestone,
  onNavigate,
  primaryDestination,
  primaryLabel,
  title,
}: ModuleStatusPageProps) {
  return (
    <section className="module-status" aria-labelledby="module-status-title">
      <div className="module-status__eyebrow">
        <StatusBadge tone="warning">Em preparação</StatusBadge>
        <span>{milestone}</span>
      </div>

      <h1 id="module-status-title">{title}</h1>
      <p className="module-status__description">{description}</p>

      <Card
        title="O que estará disponível aqui"
        description="Este destino já funciona na navegação; as operações abaixo entram nos próximos marcos do produto."
        footer={
          <Button
            type="button"
            onClick={() => onNavigate(primaryDestination)}
          >
            {primaryLabel}
          </Button>
        }
      >
        <ul className="module-status__features">
          {features.map((feature) => (
            <li key={feature}>{feature}</li>
          ))}
        </ul>
      </Card>
    </section>
  )
}
