"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Bell } from "lucide-react";
import { adminApi } from "@/lib/admin/client";
import { formatDateTime } from "@/lib/admin/client";

/**
 * The staff member's lab notifications (Phase 16): a bell with the unread
 * count and a short list. Each entry names the event, the patient and the
 * test — never values — and links to where the work is done.
 */

type Item = { id: string; type: string; title: string; detail: string | null; href: string; createdAt: string; read: boolean };

export function NotificationBell() {
  const [items, setItems] = useState<Item[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);

  const load = async () => {
    try {
      const res = await adminApi.get<{ notifications: Item[]; unread: number }>("/api/staff/notifications");
      setItems(res.notifications);
      setUnread(res.unread);
    } catch {
      // The bell is a convenience; the work queues remain the source of truth.
    }
  };
  useEffect(() => {
    void load();
    const t = setInterval(() => void load(), 60_000);
    return () => clearInterval(t);
  }, []);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (panel.current && !panel.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [open]);

  const markAll = async () => {
    try {
      await adminApi.post("/api/staff/notifications", { action: "read", ids: null });
      await load();
    } catch {
      // ignore
    }
  };

  return (
    <div className="relative" ref={panel}>
      <button
        type="button"
        aria-label={unread ? `Bildirishnomalar: ${unread} ta o‘qilmagan` : "Bildirishnomalar"}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        className="relative inline-flex h-9 w-9 items-center justify-center rounded-lg text-ink-muted hover:bg-sand"
      >
        <Bell className="h-4 w-4" />
        {unread > 0 && (
          <span className="font-numeric absolute -right-0.5 -top-0.5 min-w-[1.1rem] rounded-full bg-danger px-1 text-center text-[10px] font-bold leading-[1.1rem] text-white">
            {unread > 99 ? "99+" : unread}
          </span>
        )}
      </button>
      {open && (
        <div role="dialog" aria-label="Bildirishnomalar" className="absolute right-0 z-50 mt-2 w-80 max-w-[calc(100vw-2rem)] rounded-xl border border-hairline bg-surface p-2 shadow-lg">
          <div className="flex items-center justify-between px-2 py-1">
            <p className="text-sm font-semibold">Bildirishnomalar</p>
            {unread > 0 && (
              <button type="button" className="text-xs text-pine hover:underline" onClick={() => void markAll()}>
                Hammasini o‘qilgan deb belgilash
              </button>
            )}
          </div>
          {items.length === 0 ? (
            <p className="px-2 py-4 text-center text-sm text-ink-muted">Bildirishnoma yo‘q</p>
          ) : (
            <ul className="max-h-96 overflow-y-auto">
              {items.map((n) => (
                <li key={n.id}>
                  <Link href={n.href} onClick={() => setOpen(false)} className={`block rounded-lg px-2 py-2 text-sm hover:bg-sand ${n.read ? "text-ink-muted" : "text-foreground"}`}>
                    <span className="flex items-center gap-1.5 font-medium">
                      {!n.read && <span className="h-1.5 w-1.5 rounded-full bg-pine" aria-label="o‘qilmagan" />}
                      {n.title}
                    </span>
                    {n.detail && <span className="block text-xs">{n.detail}</span>}
                    <span className="block text-[11px] text-ink-muted">{formatDateTime(n.createdAt)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
