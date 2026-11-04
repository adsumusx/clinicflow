import type { ReactNode, SVGProps } from 'react'

export type IconName =
  | 'alert'
  | 'arrow-right'
  | 'bell'
  | 'cake'
  | 'calendar'
  | 'check'
  | 'chevron-left'
  | 'chevron-right'
  | 'clock'
  | 'inbox'
  | 'map-pin'
  | 'plus'
  | 'send'
  | 'trend-up'
  | 'user-plus'
  | 'users'

interface IconProps extends SVGProps<SVGSVGElement> {
  name: IconName
}

const paths: Record<IconName, ReactNode> = {
  alert: <><path d="M12 4 3.5 19h17L12 4Z" /><path d="M12 9v4M12 16.5h.01" /></>,
  'arrow-right': <><path d="M5 12h14M14 7l5 5-5 5" /></>,
  bell: <><path d="M6 9a6 6 0 0 1 12 0c0 7 3 7 3 7H3s3 0 3-7M10 20h4" /><path d="M18.5 3.5 20 2M5.5 3.5 4 2" /></>,
  cake: <><path d="M4 11h16v9H4zM4 15c2 1.5 3.5 1.5 5 0 2 1.5 4 1.5 6 0 1.5 1.5 3 1.5 5 0M8 11V8M12 11V7M16 11V8" /><path d="M8 5h.01M12 4h.01M16 5h.01" /></>,
  calendar: <><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M8 3v4M16 3v4M3 10h18" /></>,
  check: <><circle cx="12" cy="12" r="9" /><path d="m8 12 2.5 2.5L16 9" /></>,
  'chevron-left': <path d="m15 18-6-6 6-6" />,
  'chevron-right': <path d="m9 18 6-6-6-6" />,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  inbox: <><path d="M4 5h16l2 10v4H2v-4L4 5Z" /><path d="M2 15h5l2 2h6l2-2h5" /></>,
  'map-pin': <><path d="M20 10c0 5-8 11-8 11S4 15 4 10a8 8 0 1 1 16 0Z" /><circle cx="12" cy="10" r="2.5" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  send: <><path d="m3 4 18 8-18 8 3-8-3-8Z" /><path d="M6 12h15" /></>,
  'trend-up': <><path d="m4 16 5-5 4 4 7-8" /><path d="M15 7h5v5" /></>,
  'user-plus': <><circle cx="9" cy="8" r="3" /><path d="M3.5 20c.4-4 2.2-6 5.5-6s5.1 2 5.5 6M18 7v6M15 10h6" /></>,
  users: <><circle cx="9" cy="8" r="3" /><path d="M3.5 20c.4-4 2.2-6 5.5-6s5.1 2 5.5 6M15 5.5a3 3 0 0 1 0 5.8M16 14c2.7.3 4.1 2.2 4.5 5" /></>,
}

export function Icon({ name, className = '', ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      className={`icon ${className}`.trim()}
      fill="none"
      focusable="false"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
      viewBox="0 0 24 24"
      {...props}
    >
      {paths[name]}
    </svg>
  )
}
