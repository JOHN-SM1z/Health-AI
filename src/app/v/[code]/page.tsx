import type { Metadata } from "next";
import { headers } from "next/headers";
import { keyFromIp, rateLimit } from "@/lib/rate-limit";
import { verifyPrescriptionCode, type VerifiedDocument } from "@/lib/prescribing/prescriptions";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Hujjatni tekshirish — Health AI",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

const CHECKS_PER_MINUTE = 30;

/**
 * Public authenticity check behind the QR code on a printed prescription
 * (specification RX-07). It answers one question — is this sheet genuine and
 * still current — with the clinic, the doctor and the date. It never shows a
 * medicine or the patient, whoever scans it. An unknown or malformed code and
 * a failed lookup are told apart, so "not found" is never claimed when the
 * check simply could not run.
 */
export default async function VerifyDocumentPage({ params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const forwarded = (await headers()).get("x-forwarded-for");
  const ip = forwarded?.split(",")[0]?.trim() || null;

  let outcome: { kind: "found"; document: VerifiedDocument } | { kind: "unknown" } | { kind: "busy" } | { kind: "unavailable" };
  if (!rateLimit({ key: keyFromIp(ip, "document-verify"), limit: CHECKS_PER_MINUTE, windowMs: 60_000 }).ok) {
    outcome = { kind: "busy" };
  } else {
    try {
      const document = await verifyPrescriptionCode(code);
      outcome = document ? { kind: "found", document } : { kind: "unknown" };
    } catch {
      outcome = { kind: "unavailable" };
    }
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col gap-4 px-4 py-10">
      <p className="text-xs font-semibold uppercase tracking-widest text-slate-500">Health AI · hujjatni tekshirish</p>
      {outcome.kind === "found" && <Found document={outcome.document} />}
      {outcome.kind === "unknown" && (
        <section className="rounded-xl border border-red-300 bg-red-50 p-4">
          <h1 className="text-lg font-semibold text-red-800">Hujjat topilmadi</h1>
          <p className="mt-1 text-sm text-red-900">
            Bu kod bo‘yicha Health AI tizimida imzolangan hujjat yo‘q. Kod noto‘g‘ri ko‘chirilgan bo‘lishi mumkin — QR kodni qayta skanerlang yoki
            klinikaga murojaat qiling.
          </p>
        </section>
      )}
      {outcome.kind === "busy" && (
        <section className="rounded-xl border border-amber-300 bg-amber-50 p-4">
          <h1 className="text-lg font-semibold text-amber-900">Juda ko‘p so‘rov</h1>
          <p className="mt-1 text-sm text-amber-900">Bir daqiqadan keyin qayta urinib ko‘ring.</p>
        </section>
      )}
      {outcome.kind === "unavailable" && (
        <section className="rounded-xl border border-amber-300 bg-amber-50 p-4">
          <h1 className="text-lg font-semibold text-amber-900">Hozir tekshirib bo‘lmadi</h1>
          <p className="mt-1 text-sm text-amber-900">Hujjat tekshirilmadi — bu uning haqiqiy emasligini anglatmaydi. Keyinroq qayta urinib ko‘ring.</p>
        </section>
      )}
      <p className="text-xs text-slate-500">
        Bu sahifa faqat hujjatning haqiqiyligini tasdiqlaydi. Dorilar ro‘yxati va bemor ma’lumotlari bu yerda ko‘rsatilmaydi.
      </p>
    </main>
  );
}

function Found({ document }: { document: VerifiedDocument }) {
  const signedOn = new Intl.DateTimeFormat("uz-UZ", { dateStyle: "long", timeZone: document.clinicTimezone }).format(new Date(document.signedAt));
  const valid = document.status === "valid";
  return (
    <section className={`rounded-xl border p-4 ${valid ? "border-emerald-300 bg-emerald-50" : "border-amber-300 bg-amber-50"}`}>
      <h1 className={`text-lg font-semibold ${valid ? "text-emerald-900" : "text-amber-900"}`}>
        {valid ? "Hujjat haqiqiy va amalda" : document.status === "replaced" ? "Hujjat haqiqiy, lekin almashtirilgan" : "Hujjat haqiqiy, lekin bekor qilingan"}
      </h1>
      {!valid && (
        <p className="mt-1 text-sm text-amber-900">
          {document.status === "replaced" ? "Shifokor bu retsept o‘rniga yangisini yozgan." : "Shifokor bu retseptni bekor qilgan."} Bu varaq bo‘yicha dori
          berilmasligi kerak.
        </p>
      )}
      <dl className="mt-3 grid grid-cols-[6rem_1fr] gap-y-1 text-sm text-slate-900">
        <dt className="font-medium">Klinika</dt>
        <dd>{document.clinicName}</dd>
        <dt className="font-medium">Shifokor</dt>
        <dd>{document.doctorName}</dd>
        <dt className="font-medium">Sana</dt>
        <dd>{signedOn}</dd>
      </dl>
    </section>
  );
}
