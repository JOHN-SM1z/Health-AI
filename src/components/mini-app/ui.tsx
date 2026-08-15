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
      "bg-[var(--tg-button,var(--pine))] text-[var(--tg-button-text,#fff)] shadow-sm hover:brightness-105 active:brightness-95",
    secondary:
      "bg-[var(--tg-secondary-bg,#eef1ed)] text-[var(--tg-text,var(--foreground))] hover:brightness-95 active:brightness-90",
    outline:
      "border border-[var(--tg-secondary-bg,var(--hairline))] text-[var(--tg-text,var(--foreground))] hover:bg-[var(--tg-secondary-bg,#f1f5f9)]",
    ghost:
      "text-[var(--tg-link,var(--pine))] hover:bg-[var(--tg-secondary-bg,#f1f5f9)]",
    danger: "bg-[var(--danger)] text-white shadow-sm hover:brightness-105",
    success: "bg-[var(--pine)] text-white shadow-sm hover:brightness-105",
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
        "inline-flex items-center justify-center gap-2 font-medium transition-[filter,background-color,opacity] disabled:opacity-50 disabled:cursor-not-allowed",
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
      onChange={(e) => onChange(e.target.value)}
      className={cn(
        "w-full rounded-xl border border-[var(--tg-secondary-bg,var(--hairline))] bg-[var(--tg-bg,var(--surface))] px-4 py-3 text-sm text-[var(--tg-text,var(--foreground))] transition-[border-color] placeholder:text-[var(--tg-hint,#8a9699)] focus:border-[var(--tg-button,var(--pine))]",
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
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold tracking-wide",
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

export function EmptyState({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="py-10 text-center">
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
    <div className="mb-4 rounded-xl border border-[var(--danger)]/25 bg-[var(--danger-tint)] px-4 py-3 text-sm font-medium text-[var(--danger)]">
      {message}
    </div>
  );
}

export function NoticeBanner({ message }: { message: string }) {
  return (
    <div className="mb-4 rounded-xl border border-clay/25 bg-clay-tint px-4 py-3 text-sm font-medium text-clay-deep">
      {message}
    </div>
  );
}