"use client";

import { use, useEffect, useState } from "react";

type Queue = { clinicName: string; doctors: Array<{ name: string; called: number[]; waiting: number[] }>; at: string };

/**
 * Waiting-room screen (no paper tickets): called and waiting queue numbers
 * per doctor, refreshed every 10 seconds. Numbers and doctor names only —
 * never a patient's name. If the connection drops, the screen says so
 * instead of showing an old list as current.
 */
export default function QueueScreen({ params }: { params: Promise<{ clinicId: string }> }) {
  const { clinicId } = use(params);
  const [queue, setQueue] = useState<Queue | null>(null);
  const [stale, setStale] = useState(false);
  const [missing, setMissing] = useState(false);

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(`/api/queue/${clinicId}`, { cache: "no-store" });
        if (res.status === 404) {
          if (alive) setMissing(true);
          return;
        }
        const body = await res.json();
        if (!res.ok || !body.ok) throw new Error();
        if (alive) {
          setQueue(body.data);
          setStale(false);
        }
      } catch {
        if (alive) setStale(true);
      }
    };
    void load();
    const t = window.setInterval(load, 10_000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, [clinicId]);

  if (missing) return <main className="flex min-h-dvh items-center justify-center bg-sand p-8 text-ink-muted">Klinika topilmadi.</main>;

  return (
    <main className="min-h-dvh bg-sand p-6 md:p-10">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <h1 className="font-display text-3xl font-bold text-foreground">{queue?.clinicName ?? "Navbat"}</h1>
        <p className={stale ? "text-lg font-semibold text-danger" : "text-sm text-ink-muted"}>
          {stale ? "Aloqa yo‘q — ma’lumot eskirgan bo‘lishi mumkin" : queue ? `Yangilandi ${new Date(queue.at).toLocaleTimeString("uz-UZ")}` : "Yuklanmoqda…"}
        </p>
      </header>
      {queue && queue.doctors.length === 0 && <p className="text-xl text-ink-muted">Hozir navbat yo‘q.</p>}
      <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
        {queue?.doctors.map((d) => (
          <section key={d.name} aria-label={d.name} className="rounded-2xl border border-hairline bg-surface p-5 shadow-[var(--shadow-card)]">
            <h2 className="mb-3 font-display text-xl font-bold">{d.name}</h2>
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Kiring</p>
            <p className="mb-3 font-numeric text-5xl font-bold text-pine-deep">{d.called.length ? d.called.join(", ") : "—"}</p>
            <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">Navbatda</p>
            <p className="font-numeric text-2xl">{d.waiting.length ? d.waiting.join(", ") : "—"}</p>
          </section>
        ))}
      </div>
      <p className="mt-8 text-sm text-ink-muted">Raqamlar kelish tartibida. Bu aniq qabul vaqti emas.</p>
    </main>
  );
}
