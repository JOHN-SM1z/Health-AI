"use client";

import { useEffect, useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { adminApi } from "@/lib/admin/client";

/**
 * A type-ahead box over a server search: results appear after two characters,
 * arrow keys move, Enter selects. Only the doctor's typing drives it — the
 * list is what the catalogue holds for those letters, never a suggestion of
 * what to choose. A slower earlier answer can never replace a newer one.
 */
export function SearchPicker<T>({
  endpoint,
  resultKey,
  itemKey,
  renderItem,
  onPick,
  placeholder,
  ariaLabel,
  emptyText,
  autoFocus,
}: {
  /** GET endpoint taking `?q=`. */
  endpoint: string;
  /** The array's name in the response payload. */
  resultKey: string;
  itemKey: (item: T) => string;
  renderItem: (item: T) => ReactNode;
  onPick: (item: T) => void;
  placeholder: string;
  ariaLabel: string;
  emptyText: string;
  autoFocus?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [items, setItems] = useState<T[]>([]);
  const [active, setActive] = useState(0);
  const [state, setState] = useState<"idle" | "loading" | "ready" | "failed">("idle");
  const [open, setOpen] = useState(false);
  const sequence = useRef(0);
  const listId = useId();

  useEffect(() => {
    const text = query.trim();
    const mine = ++sequence.current;
    if (text.length < 2) {
      setItems([]);
      setState("idle");
      return;
    }
    setState("loading");
    // A short pause so each keystroke of a fast typist is not its own request.
    const timer = setTimeout(() => {
      adminApi
        .get<Record<string, T[]>>(`${endpoint}?q=${encodeURIComponent(text)}`)
        .then((res) => {
          if (mine !== sequence.current) return;
          setItems(res[resultKey] ?? []);
          setActive(0);
          setState("ready");
        })
        .catch(() => {
          if (mine !== sequence.current) return;
          setItems([]);
          setState("failed");
        });
    }, 90);
    return () => clearTimeout(timer);
  }, [query, endpoint, resultKey]);

  const pick = (item: T) => {
    onPick(item);
    setQuery("");
    setItems([]);
    setOpen(false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((i) => Math.min(i + 1, items.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter" && items[active]) {
      e.preventDefault();
      pick(items[active]);
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  const showList = open && query.trim().length >= 2;

  return (
    <div className="relative">
      <input
        type="text"
        role="combobox"
        aria-expanded={showList}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-label={ariaLabel}
        autoComplete="off"
        autoFocus={autoFocus}
        value={query}
        placeholder={placeholder}
        onChange={(e) => {
          setQuery(e.target.value);
          setOpen(true);
        }}
        onFocus={() => setOpen(true)}
        onBlur={() => setTimeout(() => setOpen(false), 150)}
        onKeyDown={onKeyDown}
        className="w-full rounded-lg border border-hairline bg-surface px-3 py-2 text-sm text-foreground placeholder:text-ink-muted/70 focus:border-pine"
      />
      {showList && (
        <ul
          id={listId}
          role="listbox"
          className="absolute z-20 mt-1 max-h-72 w-full overflow-y-auto rounded-lg border border-hairline bg-surface py-1 shadow-[var(--shadow-pop)]"
        >
          {state === "loading" && items.length === 0 && <li className="px-3 py-2 text-sm text-ink-muted">Qidirilmoqda…</li>}
          {state === "failed" && <li className="px-3 py-2 text-sm text-danger">Qidirib bo‘lmadi. Qayta urinib ko‘ring.</li>}
          {state === "ready" && items.length === 0 && <li className="px-3 py-2 text-sm text-ink-muted">{emptyText}</li>}
          {items.map((item, index) => (
            <li
              key={itemKey(item)}
              role="option"
              aria-selected={index === active}
              // mousedown, not click: the input's blur must not close the list first.
              onMouseDown={(e) => {
                e.preventDefault();
                pick(item);
              }}
              onMouseEnter={() => setActive(index)}
              className={`cursor-pointer px-3 py-2 text-sm ${index === active ? "bg-pine-tint" : ""}`}
            >
              {renderItem(item)}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
