"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { IdCard, Phone, ShieldCheck } from "lucide-react";
import { Button, Card, Input, Spinner, ErrorBanner, NoticeBanner, SectionTitle } from "@/components/mini-app/ui";
import { apiPost } from "@/lib/client/api";

/** The patient's own details, shown once they are proven (never a document number). */
export type OnlineProfile = {
  fullName: string | null;
  phone: string | null;
  dateOfBirth: string | null;
  homeAddress: string | null;
  complete: boolean;
  identityVerified?: boolean;
};

type Step =
  | { next: "phone"; lookupId: string }
  | { next: "phone_needed"; lookupId: string }
  | { next: "details"; lookupId: string; phone: string }
  | { next: "reception" }
  | { next: "done"; profile: OnlineProfile };

type View = { name: "lookup" } | { name: "phone"; lookupId: string; waiting: boolean } | { name: "details"; lookupId: string; phone: string } | { name: "reception" } | { name: "confirm"; profile: OnlineProfile };

/** "12.04.1988" / "12/04/1988" / "1988-04-12" → "1988-04-12"; null if it is not a real date. */
export function parseDob(raw: string): string | null {
  const v = raw.trim();
  let y: string, m: string, d: string;
  const dmy = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})$/.exec(v);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (dmy) [, d, m, y] = dmy;
  else if (iso) [, y, m, d] = iso;
  else return null;
  const out = `${y}-${m.padStart(2, "0")}-${d.padStart(2, "0")}`;
  const date = new Date(`${out}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === out ? out : null;
}

const showDate = (iso: string | null) => (iso ? iso.split("-").reverse().join(".") : "—");

function LabeledInput({ label, ...rest }: { label: string } & Omit<Parameters<typeof Input>[0], "aria-label">) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      <Input aria-label={label} {...rest} />
    </label>
  );
}

/**
 * Passport-first identity for the Mini App booking (owner decision 2026-10-08): passport/ID or JSHSHIR + date of birth,
 * then the patient's own Telegram phone. A returning patient's card details appear; a new patient fills in a short
 * form. The server decides everything — this screen only shows the next step it returns.
 */
export function IdentityStep({ identity, clinicPhone, onDone }: { identity: string | null; clinicPhone: string | null; onDone: (profile: OnlineProfile) => void }) {
  const [view, setView] = useState<View>({ name: "lookup" });
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [document, setDocument] = useState("");
  const [dob, setDob] = useState("");
  // Consent is given on this first screen: nothing personal is processed before it.
  const [consent, setConsent] = useState(false);
  const [fullName, setFullName] = useState("");
  const [sex, setSex] = useState<"" | "female" | "male">("");
  const [address, setAddress] = useState("");
  const polling = useRef(0);
  const [smsAvailable, setSmsAvailable] = useState(false);
  const [oneIdAvailable, setOneIdAvailable] = useState(false);
  const [oneIdWaiting, setOneIdWaiting] = useState(false);
  const [codeSent, setCodeSent] = useState<string | null>(null);
  const [code, setCode] = useState("");

  useEffect(() => {
    let cancelled = false;
    void apiPost<{ profile: OnlineProfile | null; smsAvailable?: boolean; oneIdAvailable?: boolean }>("/api/mini-app/identity/status", {}, identity).then((res) => {
      if (cancelled) return;
      if (res.ok) {
        setSmsAvailable(res.data.smsAvailable === true);
        setOneIdAvailable(res.data.oneIdAvailable === true);
      }
      if (res.ok && res.data.profile) setView({ name: "confirm", profile: res.data.profile });
      setLoading(false);
    });
    return () => {
      cancelled = true;
    };
  }, [identity]);

  const follow = useCallback((step: Step) => {
    if (step.next === "done") setView({ name: "confirm", profile: step.profile });
    else if (step.next === "details") setView({ name: "details", lookupId: step.lookupId, phone: step.phone });
    else if (step.next === "reception") setView({ name: "reception" });
    else setView({ name: "phone", lookupId: step.lookupId, waiting: false });
  }, []);

  /**
   * OneID: the patient signs in at the state identification system in the phone's browser; the details come from the
   * state, not from what was typed. This screen then follows the attempt until it ends.
   */
  const startOneId = async () => {
    setError(null);
    setBusy(true);
    const res = await apiPost<{ url: string }>("/api/mini-app/identity/oneid", { action: "start" }, identity);
    setBusy(false);
    if (!res.ok) return setError(res.error);
    try {
      const sdk = await import("@tma.js/sdk");
      const open = sdk.openLink as unknown as { (u: string): void; isAvailable?: () => boolean };
      if (open.isAvailable && !open.isAvailable()) throw new Error("unavailable");
      open(res.data.url);
    } catch {
      window.open(res.data.url, "_blank", "noopener");
    }
    const run = ++polling.current;
    setOneIdWaiting(true);
    for (let i = 0; i < 90 && run === polling.current; i++) {
      await new Promise((r) => setTimeout(r, 3000));
      const poll = await apiPost<{ pending: boolean; outcome: string | null; profile: OnlineProfile | null }>("/api/mini-app/identity/oneid", { action: "poll" }, identity);
      if (!poll.ok || poll.data.pending) continue;
      setOneIdWaiting(false);
      if (poll.data.profile) return setView({ name: "confirm", profile: poll.data.profile });
      if (poll.data.outcome === "reception") return setView({ name: "reception" });
      return setError("OneID orqali tasdiqlab bo‘lmadi. Pasport/ID va telefon orqali davom eting.");
    }
    if (run === polling.current) setOneIdWaiting(false);
  };

  const submitLookup = async () => {
    const iso = parseDob(dob);
    if (!iso) return setError("Tug‘ilgan sanani kk.oo.yyyy ko‘rinishida kiriting (masalan: 12.04.1988)");
    setBusy(true);
    setError(null);
    const res = await apiPost<Step>("/api/mini-app/identity/lookup", { document, dateOfBirth: iso, consent: true }, identity);
    setBusy(false);
    if (!res.ok) return setError(res.error);
    // A phone shared earlier may already be on record: check before asking again.
    const lookupId = (res.data as { lookupId: string }).lookupId;
    const phone = await apiPost<Step>("/api/mini-app/identity/phone", { lookupId }, identity);
    if (phone.ok) follow(phone.data);
    else follow(res.data);
  };

  /** After the phone is shared, Telegram delivers it to the bot; ask the server a few times. */
  const waitForPhone = async (lookupId: string) => {
    const run = ++polling.current;
    setView({ name: "phone", lookupId, waiting: true });
    for (let i = 0; i < 12 && run === polling.current; i++) {
      await new Promise((r) => setTimeout(r, i === 0 ? 800 : 2000));
      const res = await apiPost<Step>("/api/mini-app/identity/phone", { lookupId }, identity);
      if (!res.ok) {
        setError(res.error);
        break;
      }
      if (res.data.next !== "phone_needed") return follow(res.data);
    }
    if (run === polling.current) setView({ name: "phone", lookupId, waiting: false });
  };

  const sharePhone = async (lookupId: string) => {
    setError(null);
    setNotice(null);
    try {
      const sdk = await import("@tma.js/sdk");
      const request = sdk.requestPhoneAccess as unknown as { (): Promise<unknown>; isAvailable?: () => boolean };
      if (request.isAvailable && !request.isAvailable()) throw new Error("unavailable");
      await request();
    } catch {
      // Older Telegram apps, or outside Telegram: the bot sends a one-tap button in the chat instead.
      const res = await apiPost<{ sent: boolean }>("/api/mini-app/identity/ask-contact", {}, identity);
      if (!res.ok || !res.data.sent) return setError("Raqamni so‘rab bo‘lmadi. Bot chatini oching yoki qabulxonaga murojaat qiling.");
      setNotice("Bot chatiga tugma yuborildi: “📱 Raqamni ulashish”ni bosing, so‘ng bu yerga qayting.");
    }
    void waitForPhone(lookupId);
  };

  /** The second proof: a code to the phone on the card (same answer whether a card exists or not). */
  const sendCode = async (lookupId: string) => {
    setBusy(true);
    setError(null);
    const res = await apiPost<{ sent: string }>("/api/mini-app/identity/sms", { lookupId }, identity);
    setBusy(false);
    if (!res.ok) return setError(res.error);
    setCode("");
    setCodeSent(lookupId);
  };

  const verifyCode = async (lookupId: string) => {
    setBusy(true);
    setError(null);
    const res = await apiPost<Step>("/api/mini-app/identity/sms/verify", { lookupId, code: code.trim() }, identity);
    setBusy(false);
    if (!res.ok) return setError(res.error);
    follow(res.data);
  };

  const submitDetails = async (lookupId: string) => {
    setBusy(true);
    setError(null);
    const res = await apiPost<Step>("/api/mini-app/identity/details", { lookupId, fullName, sex: sex || null, homeAddress: address || null }, identity);
    setBusy(false);
    if (!res.ok) return setError(res.error);
    follow(res.data);
  };

  if (loading) return <Spinner label="Yuklanmoqda…" />;

  return (
    <div className="flex flex-col gap-3">
      {error && <ErrorBanner message={error} />}
      {notice && <NoticeBanner message={notice} />}

      {view.name === "lookup" && oneIdAvailable && (
        <Card className="flex flex-col gap-2 border-[var(--tg-button,var(--pine))]">
          <div className="flex items-center gap-2 text-sm font-semibold">
            <ShieldCheck className="h-4 w-4 text-[var(--tg-button,var(--pine))]" aria-hidden /> OneID orqali tasdiqlash (tavsiya etiladi)
          </div>
          <p className="text-xs text-[var(--tg-hint)]">
            id.egov.uz’ga login, ERI yoki telefon bilan kirasiz — ism, tug‘ilgan sana va hujjatingiz davlat tizimidan olinadi. Yuz tekshiruvi yo‘q.
          </p>
          {oneIdWaiting ? (
            <Spinner label="OneID’dan javob kutilmoqda… Tasdiqlagach shu yerga qayting." />
          ) : (
            <Button size="full" loading={busy} disabled={!consent} onClick={startOneId}>
              OneID bilan kirish
            </Button>
          )}
          {!consent && <p className="text-xs text-[var(--tg-hint)]">Avval quyida shaxsiy ma’lumotlarga rozilik bering.</p>}
        </Card>
      )}

      {view.name === "lookup" && (
        <>
          <SectionTitle>Shaxsingizni kiriting</SectionTitle>
          <Card className="flex flex-col gap-3">
            <div className="flex items-center gap-2 text-sm text-[var(--tg-hint)]">
              <IdCard className="h-4 w-4" aria-hidden /> Pasport / ID karta yoki JSHSHIR va tug‘ilgan sana
            </div>
            <LabeledInput label="Pasport / ID karta yoki JSHSHIR" value={document} onChange={setDocument} placeholder="AB1234567 yoki 14 raqam" />
            <LabeledInput label="Tug‘ilgan sana" value={dob} onChange={setDob} placeholder="kk.oo.yyyy" inputMode="numeric" />
            <p className="text-xs text-[var(--tg-hint)]">
              Ma’lumotlaringiz faqat klinika tizimida saqlanadi. Xodimlar faqat ismingiz va telefon raqamingizni ko‘radi. Ilova tibbiy
              tashxis qo‘ymaydi.{" "}
              <a className="underline" href="/privacy">
                Maxfiylik siyosati
              </a>
            </p>
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                checked={consent}
                onChange={(e) => setConsent(e.target.checked)}
                aria-label="Shaxsiy ma’lumotlarga rozilik"
                className="mt-0.5 h-4 w-4 accent-[var(--tg-button,var(--pine))]"
              />
              <span>Shaxsiy ma’lumotlarimni qabulga yozilish uchun ishlatishga roziman</span>
            </label>
            <Button size="full" loading={busy} disabled={!document.trim() || !dob.trim() || !consent} onClick={submitLookup}>
              Davom etish
            </Button>
          </Card>
        </>
      )}

      {view.name === "phone" && (
        <>
          <SectionTitle>Telefon raqamingizni tasdiqlang</SectionTitle>
          <Card className="flex flex-col gap-3">
            <p className="text-sm">
              Kartangizni topish uchun Telegram’dagi telefon raqamingizni ulashing. Raqam faqat tasdiqlash uchun ishlatiladi.
            </p>
            {view.waiting ? (
              <Spinner label="Raqam kutilmoqda…" />
            ) : (
              <Button size="full" onClick={() => sharePhone(view.lookupId)}>
                <Phone className="h-4 w-4" aria-hidden /> Raqamni ulashish
              </Button>
            )}
            <Button variant="ghost" size="full" onClick={() => setView({ name: "lookup" })}>
              Orqaga
            </Button>
          </Card>
        </>
      )}

      {view.name === "details" && smsAvailable && (
        <Card className="flex flex-col gap-2">
          <p className="text-sm">Klinikada kartangiz bormi, lekin unda boshqa telefon raqam yozilganmi?</p>
          {codeSent === view.lookupId ? (
            <>
              <p className="text-xs text-[var(--tg-hint)]">Agar kartangizda telefon raqam bo‘lsa, unga 6 xonali kod yuborildi.</p>
              <LabeledInput label="SMS kod" value={code} onChange={setCode} placeholder="000000" inputMode="numeric" />
              <Button size="full" loading={busy} disabled={!/^\d{6}$/.test(code.trim())} onClick={() => verifyCode(view.lookupId)}>
                Kodni tasdiqlash
              </Button>
            </>
          ) : (
            <Button variant="outline" size="full" loading={busy} onClick={() => sendCode(view.lookupId)}>
              Kartadagi raqamga SMS kod yuborish
            </Button>
          )}
        </Card>
      )}

      {view.name === "details" && (
        <>
          <SectionTitle>Ma’lumotlaringiz</SectionTitle>
          <Card className="flex flex-col gap-3">
            <p className="text-sm text-[var(--tg-hint)]">Tasdiqlangan telefon: {view.phone}</p>
            <LabeledInput label="F.I.Sh." value={fullName} onChange={setFullName} placeholder="Familiya Ism Otasining ismi" />
            <label className="flex flex-col gap-1 text-sm">
              Jinsi (ixtiyoriy)
              <select className="rounded-xl border px-3 py-2" value={sex} onChange={(e) => setSex(e.target.value as "" | "female" | "male")}>
                <option value="">Ko‘rsatilmagan</option>
                <option value="female">Ayol</option>
                <option value="male">Erkak</option>
              </select>
            </label>
            <LabeledInput label="Yashash manzili (ixtiyoriy)" value={address} onChange={setAddress} placeholder="Tuman, ko‘cha, uy" />
            <Button size="full" loading={busy} disabled={fullName.trim().length < 2} onClick={() => submitDetails(view.lookupId)}>
              Saqlash va davom etish
            </Button>
          </Card>
        </>
      )}

      {view.name === "reception" && (
        <Card className="flex flex-col gap-3">
          <SectionTitle>Qabulxonada tasdiqlash kerak</SectionTitle>
          <p className="text-sm">
            Kartangizni onlayn ulab bo‘lmadi. Iltimos, qabulxonaga murojaat qiling{clinicPhone ? ` (${clinicPhone})` : ""} — ma’lumotlaringizni tasdiqlab
            berishadi.
          </p>
          <Button variant="ghost" size="full" onClick={() => setView({ name: "lookup" })}>
            Orqaga
          </Button>
        </Card>
      )}

      {view.name === "confirm" && (
        <>
          <SectionTitle>Ma’lumotlaringiz</SectionTitle>
          <Card className="flex flex-col gap-2 text-sm">
            {view.profile.identityVerified ? (
              <p className="flex items-center gap-1.5 text-xs font-semibold text-[var(--tg-button,var(--pine))]">
                <ShieldCheck className="h-3.5 w-3.5" aria-hidden /> Shaxsingiz tasdiqlangan
              </p>
            ) : (
              <p className="rounded-lg bg-[var(--clay-tint,#fbeae2)] px-2.5 py-1.5 text-xs text-[var(--clay-deep,#a35532)]">
                Birinchi kelganingizda qabulxonada pasport yoki ID kartangizni ko‘rsating — shaxsingiz tasdiqlanadi.
              </p>
            )}
            <div>
              <span className="text-[var(--tg-hint)]">F.I.Sh.: </span>
              {view.profile.fullName ?? "—"}
            </div>
            <div>
              <span className="text-[var(--tg-hint)]">Tug‘ilgan sana: </span>
              {showDate(view.profile.dateOfBirth)}
            </div>
            <div>
              <span className="text-[var(--tg-hint)]">Telefon: </span>
              {view.profile.phone ?? "—"}
            </div>
            {view.profile.homeAddress && (
              <div>
                <span className="text-[var(--tg-hint)]">Manzil: </span>
                {view.profile.homeAddress}
              </div>
            )}
            <p className="text-xs text-[var(--tg-hint)]">Xato bo‘lsa, qabulxonada tuzatib berishadi.</p>
            <Button size="full" onClick={() => onDone(view.profile)}>
              Ha, davom etish
            </Button>
          </Card>
        </>
      )}
    </div>
  );
}
