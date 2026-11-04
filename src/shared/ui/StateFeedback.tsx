import { useId, type HTMLAttributes, type ReactNode } from 'react'
import { Icon, type IconName } from './Icon'
import './StateFeedback.css'

type StateTone = 'empty' | 'error' | 'loading' | 'success'

export interface SharedStateProps
  extends Omit<HTMLAttributes<HTMLDivElement>, 'title'> {
  action?: ReactNode
  compact?: boolean
  description?: ReactNode
  title: ReactNode
}

interface StateFeedbackProps extends SharedStateProps {
  tone: StateTone
}

const stateIcons: Partial<Record<StateTone, IconName>> = {
  empty: 'inbox',
  error: 'alert',
  success: 'check',
}

function StateFeedback({
  action,
  className = '',
  compact = false,
  description,
  title,
  tone,
  ...props
}: StateFeedbackProps) {
  const generatedId = useId()
  const titleId = `${generatedId}-title`
  const descriptionId = description ? `${generatedId}-description` : undefined
  const classes = [
    'state-feedback',
    `state-feedback--${tone}`,
    compact && 'state-feedback--compact',
    className,
  ]
    .filter(Boolean)
    .join(' ')
  const role = tone === 'error' ? 'alert' : tone === 'empty' ? 'region' : 'status'
  const iconName = stateIcons[tone]

  return (
    <div
      {...props}
      className={classes}
      role={role}
      aria-busy={tone === 'loading' || undefined}
      aria-describedby={descriptionId}
      aria-labelledby={titleId}
      aria-live={tone === 'empty' ? undefined : tone === 'error' ? 'assertive' : 'polite'}
    >
      <span className="state-feedback__visual" aria-hidden="true">
        {tone === 'loading' ? (
          <span className="state-feedback__spinner" />
        ) : (
          iconName && <Icon name={iconName} />
        )}
      </span>

      <div className="state-feedback__body">
        <h2 id={titleId}>{title}</h2>
        {description && <p id={descriptionId}>{description}</p>}
      </div>

      {action && <div className="state-feedback__action">{action}</div>}
    </div>
  )
}

export function LoadingState(props: SharedStateProps) {
  return <StateFeedback {...props} tone="loading" />
}

export function EmptyState(props: SharedStateProps) {
  return <StateFeedback {...props} tone="empty" />
}

export function ErrorState(props: SharedStateProps) {
  return <StateFeedback {...props} tone="error" />
}

export function SuccessState(props: SharedStateProps) {
  return <StateFeedback {...props} tone="success" />
}
