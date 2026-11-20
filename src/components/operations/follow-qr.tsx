"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";
import { AButton } from "@/components/admin/ui";
import { adminApi, AdminApiError } from "@/lib/admin/client";

/**
 * The patient's way into the Telegram queue (owner, 2026-10-08 — digital, no
 * paper): a QR code of a one-time link to the clinic's bot. Scanning it
 * follows THIS visit's queue only — the number, how many are ahead and "you
 * are called"; it opens nothing else. The server issues the link (a new one
 * replaces an unused one); this only draws it.
 */
export function FollowQr({ visitId, auto = false }: { visitId: string; auto?: boolean }) {
  const [url, setUrl] = useState<string | null>(null);
  const [image, setImage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const issue = async () => {
    setError(null);
    setLoading(true);
    try {
      const r = await adminApi.post<{ url: string }>(`/api/operations/visits/${visitId}/follow-link`, {});
      setImage(await QRCode.toDataURL(r.url, { margin: 1, width: 220, errorCorrectionLevel: "M" }));
      setUrl(r.url);
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "QR kodni yaratib bo‘lmadi");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    // Issued once when shown automatically (the kassa, right after payment).
    // Deferred so a mount that is immediately undone never issues a link that
    // the next one would replace.
    if (!auto) return;
    const timer = setTimeout(() => void issue(), 0);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto, visitId]);

  if (url && image) {
    return (
      <figure className="flex flex-col items-center gap-2" data-follow-url={url}>
        {/* eslint-disable-next-line @next/next/no-img-element -- a generated data: URL, not a remote image */}
        <img src={image} width={220} height={220} alt="Telegramda navbatni kuzatish uchun QR kod" className="rounded-lg bg-white p-1" />
        <figcaption className="max-w-60 text-center text-xs text-ink-muted">
          Bemor telefon kamerasi bilan skanerlasin — navbati va chaqiruv Telegramga keladi. Kartasi va natijalari ochilmaydi.
        </figcaption>
      </figure>
    );
  }
  return (
    <div className="flex flex-col items-start gap-1">
      {!auto && (
        <AButton size="sm" variant="outline" onClick={issue} loading={loading}>
          Telegram QR
        </AButton>
      )}
      {auto && loading && <p className="text-xs text-ink-muted">QR kod tayyorlanmoqda…</p>}
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
