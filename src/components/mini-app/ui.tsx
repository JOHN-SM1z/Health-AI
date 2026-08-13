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
    primary: "bg-[var(--tg-button,#16a34a)] text-[var(--tg-button-text,#fff)] hover:opacity-90",
    secondary: "bg-[var(--tg-secondary-bg,#f1f5f9)] text-[var(--tg-text,#0f172a)] hover:opacity-90",
    outline: "border border-[var(--tg-secondary-bg,#cbd5e1)] text-[var(--tg-text,#0f172a)] hover:bg-[var(--tg-secondary-bg,#f1f5f9)]",
    ghost: "text-[var(--tg-link,#0284c7)] hover:bg-[var(--tg-secondary-bg,#f1f5f9)]",
    danger: "bg-red-600 text-white hover:opacity-90",
    success: "bg-green-600 text-white hover:opacity-90",
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
        "inline-flex items-center justify-center gap-2 font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed",
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
        "rounded-2xl border border-[var(--tg-secondary-bg,#e2e8f0)] bg-[var(--tg-secondary-bg,#ffffff)] p-4",
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
        "w-full rounded-xl border border-[var(--tg-secondary-bg,#cbd5e1)] bg-[var(--tg-bg,#ffffff)] px-4 py-3 text-sm text-[var(--tg-text,#0f172a)] outline-none focus:border-[var(--tg-button,#16a34a)]",
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
  tone?: "neutral" | "green" | "red" | "amber" | "blue" | "gray";
  className?: string;
}) {
  const tones: Record<string, string> = {
    neutral: "bg-slate-100 text-slate-700",
    green: "bg-green-100 text-green-800",
    red: "bg-red-100 text-red-700",
    amber: "bg-amber-100 text-amber-800",
    blue: "bg-blue-100 text-blue-800",
    gray: "bg-gray-100 text-gray-600",
  };
  return (
    <span className={cn("inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium", tones[tone], className)}>
      {children}
    </span>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center justify-center gap-2 py-8 text-sm text-[var(--tg-hint,#64748b)]">
      <span className="h-5 w-5 animate-spin rounded-full border-2 border-[var(--tg-button,#16a34a)] border-t-transparent" />
      {label ?? "Yuklanmoqda..."}
    </div>
  );
}

export function EmptyState({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="py-10 text-center">
      <p className="font-medium text-[var(--tg-text,#0f172a)]">{title}</p>
      {subtitle && <p className="mt-1 text-sm text-[var(--tg-hint,#64748b)]">{subtitle}</p>}
    </div>
  );
}

export function SectionTitle({ children }: { children: ReactNode }) {
  return <h2 className="mb-2 text-base font-semibold text-[var(--tg-text,#0f172a)]">{children}</h2>;
}

export function ErrorBanner({ message }: { message: string }) {
  return (
    <div className="mb-4 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
      {message}
    </div>
  );
}

export function NoticeBanner({ message }: { message: string }) {
  return (
    <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
      {message}
    </div>
  );
}