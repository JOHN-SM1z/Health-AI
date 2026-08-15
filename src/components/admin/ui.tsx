import { createElement, type ReactNode } from "react";
import { cn } from "@/components/mini-app/ui";

export function PageHeader({ title, subtitle, action }: { title: string; subtitle?: string; action?: ReactNode }) {
  return (
    <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
      <div>
        <p className="font-numeric text-[11px] font-medium uppercase tracking-[0.14em] text-ink-muted">
          Health AI — Boshqaruv
        </p>
        <h1 className="font-display mt-1 text-2xl font-bold tracking-tight text-foreground">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-ink-muted">{subtitle}</p>}
      </div>
      {action}
    </div>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "rounded-2xl border border-hairline bg-surface p-4 shadow-[var(--shadow-card)]",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** Stat tile: mono numeral + label — the "instrument readout" voice. */
export function StatCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string | number;
  tone?: "pine" | "clay" | "info" | "neutral";
}) {
  const tones = {
    pine: "text-pine",
    clay: "text-clay",
    info: "text-info",
    neutral: "text-foreground",
  } as const;
  return (
    <div className="rounded-2xl border border-hairline bg-surface p-4 shadow-[var(--shadow-card)]">
      <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-ink-muted">{label}</p>
      <p className={`font-numeric mt-1.5 text-2xl font-bold ${tones[tone ?? "neutral"]}`}>{value}</p>
    </div>
  );
}

export function AButton({
  children,
  onClick,
  type = "button",
  variant = "primary",
  size = "md",
  disabled,
  loading,
  className,
}: {
  children: ReactNode;
  onClick?: () => void;
  type?: "button" | "submit";
  variant?: "primary" | "secondary" | "outline" | "ghost" | "danger";
  size?: "sm" | "md" | "lg";
  disabled?: boolean;
  loading?: boolean;
  className?: string;
}) {
  const styles: Record<string, string> = {
    primary: "bg-pine text-white shadow-sm hover:brightness-110 active:brightness-95",
    secondary: "bg-pine-tint text-pine-deep hover:brightness-95",
    outline: "border border-hairline bg-surface text-foreground hover:bg-sand",
    ghost: "text-pine hover:bg-pine-tint",
    danger: "bg-danger text-white shadow-sm hover:brightness-110",
  };
  const sizes: Record<string, string> = {
    sm: "px-2.5 py-1.5 text-xs rounded-lg",
    md: "px-4 py-2 text-sm rounded-lg",
    lg: "px-5 py-2.5 text-sm rounded-xl",
  };
  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled || loading}
      className={cn(
        "inline-flex items-center justify-center gap-1.5 font-medium transition-[filter,background-color] disabled:cursor-not-allowed disabled:opacity-50",
        styles[variant],
        sizes[size],
        className,
      )}
    >
      {loading && (
        <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
      )}
      {children}
    </button>
  );
}

const fieldBase =
  "w-full rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-foreground transition-[border-color] placeholder:text-ink-muted/70 focus:border-pine";

export function AInput({
  value,
  onChange,
  placeholder,
  type = "text",
  className,
  "aria-label": ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: string;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <input
      type={type}
      value={value}
      aria-label={ariaLabel}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className={cn(fieldBase, className)}
    />
  );
}

export function ASelect({
  value,
  onChange,
  options,
  className,
  "aria-label": ariaLabel,
}: {
  value: string;
  onChange: (v: string) => void;
  options: Array<{ value: string; label: string }>;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <select
      value={value}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
      className={cn(fieldBase, className)}
    >
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function ATextArea({
  value,
  onChange,
  placeholder,
  rows = 3,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  rows?: number;
  className?: string;
}) {
  return (
    <textarea
      value={value}
      rows={rows}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className={cn(fieldBase, className)}
    />
  );
}

export function ABadge({
  children,
  tone = "neutral",
}: {
  children: ReactNode;
  tone?: "neutral" | "green" | "red" | "amber" | "blue" | "gray" | "purple" | "pine";
}) {
  const tones: Record<string, string> = {
    neutral: "bg-ink-muted/10 text-ink-muted",
    green: "bg-pine-tint text-pine-deep",
    red: "bg-danger-tint text-danger",
    amber: "bg-clay-tint text-clay-deep",
    blue: "bg-info-tint text-info",
    gray: "bg-ink-muted/5 text-ink-muted",
    purple: "bg-[#efe9f8] text-[#6d4aa8]",
    pine: "bg-pine text-white",
  };
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold tracking-wide",
        tones[tone],
      )}
    >
      {children}
    </span>
  );
}

export function ATable({ headers, children }: { headers: string[]; children: ReactNode }) {
  return (
    <div className="overflow-x-auto rounded-2xl border border-hairline bg-surface shadow-[var(--shadow-card)]">
      <table className="w-full text-left text-sm">
        <thead>
          <tr className="border-b border-hairline bg-sand/60">
            {headers.map((h) => (
              <th
                key={h}
                className="px-4 py-3 text-[11px] font-semibold uppercase tracking-[0.12em] text-ink-muted"
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-hairline/70">{children}</tbody>
      </table>
    </div>
  );
}

export function AEmpty({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <div className="py-10 text-center">
      <p className="font-display font-semibold text-ink-muted">{title}</p>
      {subtitle && <p className="mt-1 text-sm text-ink-muted/80">{subtitle}</p>}
    </div>
  );
}

export function AError({ message }: { message: string }) {
  return (
    <div className="mb-4 rounded-xl border border-danger/25 bg-danger-tint px-4 py-3 text-sm font-medium text-danger">
      {message}
    </div>
  );
}

export function LoadingRow() {
  return (
    <div className="space-y-2 py-6">
      {createElement("div", { className: "h-2 w-full animate-pulse rounded bg-hairline" })}
      {createElement("div", { className: "h-2 w-3/4 animate-pulse rounded bg-hairline/70" })}
    </div>
  );
}