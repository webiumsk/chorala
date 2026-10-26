import { cva, type VariantProps } from 'class-variance-authority'
import type {
  AnchorHTMLAttributes,
  ButtonHTMLAttributes,
  HTMLAttributes,
  InputHTMLAttributes,
  LabelHTMLAttributes,
  SelectHTMLAttributes,
  TextareaHTMLAttributes,
} from 'react'
import { cn } from '@/lib/cn'

const button = cva(
  'inline-flex items-center justify-center gap-2 rounded-[10px] text-sm font-semibold tracking-[-0.01em] transition-[transform,background-color,box-shadow,border-color] duration-150 outline-none focus-visible:ring-2 focus-visible:ring-accent/35 active:translate-y-px disabled:opacity-50 disabled:pointer-events-none cursor-pointer',
  {
    variants: {
      variant: {
        default:
          'bg-accent text-white shadow-[0_1px_0_rgba(255,255,255,0.25)_inset,0_8px_18px_-10px_rgba(217,81,42,0.8)] hover:bg-accent-hover',
        secondary:
          'bg-raised text-ink border border-line-strong hover:border-ink-faint hover:bg-paper',
        outline: 'border border-line-strong bg-transparent text-ink hover:bg-raised',
        ghost: 'text-ink-soft hover:bg-ink/5 hover:text-ink',
        danger: 'bg-red-600 text-white hover:bg-red-700',
      },
      size: {
        default: 'h-9 px-4',
        sm: 'h-8 px-3 text-xs',
        lg: 'h-11 px-6 text-[15px]',
        icon: 'h-9 w-9',
      },
    },
    defaultVariants: { variant: 'default', size: 'default' },
  },
)

export function Button({
  className,
  variant,
  size,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & VariantProps<typeof button>) {
  return <button className={cn(button({ variant, size }), className)} {...props} />
}

export function LinkButton({
  className,
  variant,
  size,
  ...props
}: AnchorHTMLAttributes<HTMLAnchorElement> & VariantProps<typeof button>) {
  return <a className={cn(button({ variant, size }), className)} {...props} />
}

const field =
  'h-10 w-full rounded-[10px] border border-line-strong bg-raised px-3 text-sm text-ink shadow-[0_1px_2px_rgba(28,24,21,0.03)_inset] outline-none transition placeholder:text-ink-faint focus:border-accent focus:ring-2 focus:ring-accent/20'

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(field, className)} {...props} />
}

export function Textarea({ className, ...props }: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={cn(field, 'min-h-24 py-2.5 leading-relaxed', className)} {...props} />
}

export function Select({ className, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return <select className={cn(field, 'cursor-pointer pr-8', className)} {...props} />
}

export function Card({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('surface', className)} {...props} />
}

export function Label({ className, ...props }: LabelHTMLAttributes<HTMLLabelElement>) {
  return (
    <label
      className={cn(
        'mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.08em] text-ink-soft',
        className,
      )}
      {...props}
    />
  )
}

export function Badge({
  className,
  color,
  children,
  ...props
}: HTMLAttributes<HTMLSpanElement> & { color?: string }) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-xs font-medium',
        !color && 'border-line bg-ink/[0.04] text-ink-soft',
        className,
      )}
      style={
        color ? { backgroundColor: `${color}14`, color, borderColor: `${color}33` } : undefined
      }
      {...props}
    >
      {color && (
        <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: color }} aria-hidden />
      )}
      {children}
    </span>
  )
}

/** The signature tactile upvote pill. */
export function VotePill({
  count,
  voted,
  size = 'md',
  className,
}: {
  count: number
  voted?: boolean
  size?: 'sm' | 'md' | 'lg'
  className?: string
}) {
  const dims =
    size === 'lg'
      ? 'h-16 w-14 text-lg'
      : size === 'sm'
        ? 'h-11 w-11 text-sm'
        : 'h-14 w-12 text-base'
  return (
    <span className={cn('vote-pill', dims, className)} data-voted={voted ? 'true' : 'false'}>
      <span className="caret">▲</span>
      {count}
    </span>
  )
}
