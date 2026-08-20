import type { ReactNode } from "react";

export function cn(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

type ButtonProps = {
  children: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  variant?: "primary" | "secondary" | "outline" | "ghost" | "danger" | "success";
  size?: "sm" | "md" | "lg" | "full";
  disabled?: boolean;
  loading?: boolean;
  className?: string;
};

export function Button({
  children,
  onClick,
  type = "button",
  variant = "primary",
  size = "md",
  disabled,
  loading,
  className,
}: ButtonProps) {
  const styles: Record<NonNullable<ButtonProps["variant"]>, string> = {
    primary:
      "bg-[var(--tg-button,var(--pine))] text-[var(--tg-button-text,#fff)] shadow-sm hover:brightness-[1.06] active:brightness-[0.97]",
    secondary:
      "bg-[var(--tg-secondary-bg,#eef1ed)] text-[var(--tg-text,var(--foreground))] hover:brightness-[0.97] active:brightness-[0.93]",
    outline:
      "border border-[var(--tg-secondary-bg,var(--hairline))] bg-[var(--tg-bg,var(--surface))] text-[var(--tg-text,var(--foreground))] hover:bg-[var(--tg-secondary-bg,#f1f5f9)]",
    ghost: "text-[var(--tg-link,var(--pine))] hover:bg-[var(--tg-secondary-bg,#f1f5f9)]",
    danger: "bg-[var(--danger)] text-white shadow-sm hover:brightness-[1.06]",
    success: "bg-[var(--pine)] text-white shadow-sm hover:brightness-[1.06]",
  };
  const sizes: Record<NonNullable<ButtonProps["size"]>, string> = {
    sm: "px-3 py-1.5 text-sm rounded-lg",
    md: "px-4 py-2.5 text-sm rounded-xl",
    lg: "px-5 py-3 text-base rounded-xl",
    full: "w-full px-4 py-3 text-base rounded-xl",
  };

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || loading}
      className={cn(
        "inline-flex items-center justify-center gap-2 font-medium transition-[filter,background-color,box-shadow,opacity] duration-150 disabled:cursor-not-allowed disabled:opacity-50",
        styles[variant],
        sizes[size],
        className,
      )}
    >
      {loading && (
        <span className="h-4 w-4 animate-spin rounded-full border-2 border-current border-t-transparent" />
      )}
      {children}
    </button>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-[var(--tg-secondary-bg,var(--hairline))] bg-[var(--tg-secondary-bg,var(--surface))] p-4 shadow-[var(--shadow-card)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

export function Input({
  value,
  onChange,
  placeholder,
  type = "text",
  inputMode,
  required,
  autoComplete,
  className,
  "aria-label": ariaLabel,
  id,
  maxLength,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  inputMode?: "tel" | "text" | "numeric";
  required?: boolean;
  autoComplete?: string;
  className?: string;
  "aria-label"?: string;
  id?: string;
  maxLength?: number;
}) {
  return (
    <input
      id={id}
      type={type}
      value={value}
      inputMode={inputMode}
      required={required}
      autoComplete={autoComplete}
      aria-label={ariaLabel}
      placeholder={placeholder}
      maxLength={maxLength}
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        "w-full rounded-xl border border-[var(--tg-secondary-bg,var(--hairline))] bg-[var(--tg-bg,var(--surface))] px-4 py-3 text-sm text-[var(--tg-text,var(--foreground))] transition-[border-color,box-shadow] duration-150 placeholder:text-[var(--tg-hint,#8a9699)] focus:border-[var(--tg-button,var(--pine))]",
        className,
      )}
    />
  );
}

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: ReactNode;
  tone?: "neutral" | "green" | "red" | "amber" | "blue" | "gray" | "pine";
  className?: string;
}) {
  const tones: Record<string, string> = {
    neutral: "bg-[var(--ink-muted)]/10 text-[var(--ink-muted)]",
    green: "bg-[var(--pine-tint)] text-[var(--pine-deep)]",
    red: "bg-[var(--danger-tint)] text-[var(--danger)]",
    amber: "bg-[var(--clay-tint)] text-[var(--clay)]",
    blue: "bg-[var(--info-tint)] text-[var(--info)]",
    gray: "bg-[var(--ink-muted)]/5 text-[var(--ink-muted)]",
    pine: "bg-[var(--pine)] text-white",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-semibold tracking-wide",
        tones[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-8 text-sm text-[var(--tg-hint,#8a9699)]">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-[var(--tg-button,var(--pine))] border-t-transparent" />
      {label ?? "Yuklanmoqda..."}
    </div>
  );
}

export function EmptyState({
  title,
  subtitle,
  icon,
}: {
  title: string;
  subtitle?: ReactNode;
  icon?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-10 text-center">
      {icon && <div className="mb-3 text-[var(--tg-hint,#8a9699)]">{icon}</div>}
      <p className="font-display font-semibold text-[var(--tg-text,var(--foreground))]">{title}</p>
      {subtitle && <p className="mt-1 text-sm text-[var(--tg-hint,#8a9699)]">{subtitle}</p>}
    </div>
  );
}

/** Small mono uppercase label — the "eyebrow" above section titles. */
export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <p className="font-numeric text-[11px] font-medium uppercase tracking-[0.14em] text-[var(--tg-hint,#8a9699)]">
      {children}
    </p>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return (
    <h2 className="font-display mb-2 text-base font-semibold tracking-tight text-[var(--tg-text,var(--foreground))]">
      {children}
    </h2>
  );
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="mb-4 flex items-start gap-2.5 rounded-xl border border-[var(--danger)]/25 bg-[var(--danger-tint)] px-4 py-3 text-sm font-medium text-[var(--danger)]">
      <span aria-hidden>⚠️</span>
      <span>{message}</span>
    </div>
  );
}

export function NoticeBanner({ message }: { message: string }) {
  return (
    <div className="mb-4 flex items-start gap-2.5 rounded-xl border border-clay/25 bg-clay-tint px-4 py-3 text-sm font-medium text-clay-deep">
      <span aria-hidden>ℹ️</span>
      <span>{message}</span>
    </div>
  );
}
