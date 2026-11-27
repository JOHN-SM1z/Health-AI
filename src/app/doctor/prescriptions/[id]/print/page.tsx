"use client";

import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import QRCode from "qrcode";
import { AButton, AError, LoadingRow } from "@/components/admin/ui";
import { adminApi, AdminApiError, formatDateTime } from "@/lib/admin/client";
import { PRESCRIPTION_STATUS_LABELS, TIMING_LABELS, drugLabel, type Timing } from "@/lib/prescribing/options";

type Item = {
  id: string;
  position: number;
  inn: string;
  tradeName: string | null;
  form: string | null;
  strength: string | null;
  rxOnly: boolean;
  dose: number;
  doseUnit: string;
  route: string;
  frequency: string;
  timing: Timing;
  days: number;
  quantity: number;
  instructions: string | null;
};

type PrescriptionDocument = {
  prescription: {
    id: string;
    status: "signed" | "replaced" | "cancelled";
    signedAt: string | null;
    author: { name: string | null };
    nationalRxNumber: string | null;
    items: Item[];
  };
  clinic: { name: string; address: string | null; phone: string | null };
  patient: { fullName: string | null };
  verificationPath: string | null;
};

/**
 * The printed prescription (specification RX-07): clinic, doctor, date, items
 * and a QR code of the verification link. The link confirms only that the
 * sheet is genuine and current. For prescription-only medicines the sheet
 * says plainly that the legal prescription is the national Elektron retsept
 * record; a replaced or cancelled prescription prints with that across it.
 */
export default function PrescriptionPrintPage() {
  const { id } = useParams<{ id: string }>();
  const [document, setDocument] = useState<PrescriptionDocument | null>(null);
  const [qr, setQr] = useState<{ image: string; url: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await adminApi.get<{ document: PrescriptionDocument }>(`/api/doctor/prescriptions/${id}`);
        if (cancelled) return;
        setDocument(res.document);
        if (res.document.verificationPath) {
          const url = `${window.location.origin}${res.document.verificationPath}`;
          const image = await QRCode.toDataURL(url, { margin: 1, width: 180, errorCorrectionLevel: "M" });
          if (!cancelled) setQr({ image, url });
        }
      } catch (e) {
        if (!cancelled) setError(e instanceof AdminApiError ? e.message : "Retseptni yuklab bo‘lmadi");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) return <AError message={error} />;
  if (!document) return <LoadingRow />;

  const { prescription, clinic, patient } = document;
  const current = prescription.status === "signed";
  const hasRxOnly = prescription.items.some((i) => i.rxOnly);

  return (
    <div className="mx-auto max-w-2xl bg-white p-8 text-[#10282e] print:p-0">
      <div className="flex items-start justify-between gap-4 border-b border-[#10282e]/20 pb-4">
        <div>
          <p className="text-lg font-bold">{clinic.name}</p>
          {clinic.address && <p className="text-sm">{clinic.address}</p>}
          {clinic.phone && <p className="text-sm">{clinic.phone}</p>}
        </div>
        <div className="text-right">
          <p className="text-lg font-bold">Retsept</p>
          <p className="text-sm">{formatDateTime(prescription.signedAt)}</p>
        </div>
      </div>

      {!current && (
        <p className="mt-4 border-2 border-[#b42318] p-2 text-center text-base font-bold uppercase text-[#b42318]" role="alert">
          {PRESCRIPTION_STATUS_LABELS[prescription.status]} — bu retsept amalda emas
        </p>
      )}

      <dl className="mt-4 grid grid-cols-[8rem_1fr] gap-y-1 text-sm">
        <dt className="font-medium">Bemor</dt>
        <dd>{patient.fullName ?? "—"}</dd>
        <dt className="font-medium">Shifokor</dt>
        <dd>{prescription.author.name ?? "—"}</dd>
        {prescription.nationalRxNumber && (
          <>
            <dt className="font-medium">Milliy e-retsept</dt>
            <dd>{prescription.nationalRxNumber}</dd>
          </>
        )}
      </dl>

      <ol className="mt-5 flex flex-col gap-3">
        {prescription.items.map((item) => (
          <li key={item.id} className="text-sm">
            <p className="font-semibold">
              {item.position}. {drugLabel(item)}
              {item.rxOnly ? " (retsept bilan)" : ""}
            </p>
            <p>
              {item.dose} {item.doseUnit}, {item.route}, {item.frequency}
              {item.timing === "any" ? "" : `, ${TIMING_LABELS[item.timing].toLowerCase()}`}, {item.days} kun, jami {item.quantity}
            </p>
            {item.instructions && <p>{item.instructions}</p>}
          </li>
        ))}
      </ol>

      {hasRxOnly && (
        <p className="mt-5 border border-[#10282e]/30 p-2 text-xs">
          Retsept bilan beriladigan dorilar uchun yuridik kuchga ega retsept — Sog‘liqni saqlash vazirligining «Elektron retsept» tizimidagi
          yozuv. Ushbu varaq shifokor tayinlovining nusxasi bo‘lib, dorixonada retsept o‘rnini bosmaydi.
        </p>
      )}

      <div className="mt-6 flex items-end justify-between gap-4">
        <div className="text-sm">
          <p>Shifokor imzosi: ______________________</p>
        </div>
        {qr ? (
          <div className="text-right">
            {/* A data: URL drawn in the browser; next/image has nothing to optimize here. */}
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={qr.image} alt="Hujjatni tekshirish uchun QR kod" width={120} height={120} className="ml-auto" />
            <p className="mt-1 max-w-[16rem] break-all text-[10px]">{qr.url}</p>
            <p className="text-[10px]">QR kod hujjat haqiqiyligini tasdiqlaydi. Dorilar ro‘yxatini ko‘rsatmaydi.</p>
          </div>
        ) : (
          <p className="max-w-[16rem] text-right text-[10px]">Tekshirish kodi mavjud emas.</p>
        )}
      </div>

      <div className="mt-6 print:hidden">
        <AButton onClick={() => window.print()}>Chop etish</AButton>
      </div>
    </div>
  );
}
