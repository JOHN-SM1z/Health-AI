"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/browser";
import { isValidLogin, normalizeLogin, signInEmail, suggestLogin } from "@/lib/auth/login";
import { formatUzs, type Plan } from "@/lib/billing/status";

const MIN_PASSWORD = 12;

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5 text-sm">
      <span className="text-xs font-semibold text-ink-muted">{label}</span>
      {children}
      {hint && <span className="text-[11.5px] text-ink-muted">{hint}</span>}
    </label>
  );
}

const input =
  "w-full rounded-xl border border-hairline bg-white px-3.5 py-2.5 text-[15px] text-foreground outline-none transition focus:border-pine focus:ring-4 focus:ring-[var(--ring)]";

/** The clinic sign-up form: clinic, owner, login + password, plan. On success the owner is signed in at once. */
export function SignupForm({ plans, initialPlan }: { plans: Plan[]; initialPlan: string }) {
  const router = useRouter();
  const [f, setF] = useState({
    clinicName: "",
    city: "",
    clinicPhone: "",
    address: "",
    ownerName: "",
    ownerPhone: "",
    login: "",
    password: "",
    repeat: "",
    planCode: initialPlan,
    acceptTerms: false,
    website: "",
  });
  const [loginTouched, setLoginTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const set = <K extends keyof typeof f>(k: K) => (v: (typeof f)[K]) => setF((prev) => ({ ...prev, [k]: v }));

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const login = normalizeLogin(f.login);
    if (f.clinicName.trim().length < 2) return setError("Klinika nomini kiriting");
    if (f.city.trim().length < 2) return setError("Shaharni kiriting");
    if (f.ownerName.trim().length < 2) return setError("Ismingizni kiriting");
    if (!isValidLogin(login)) return setError("Login 3–32 belgi: lotin harflari, raqamlar, nuqta, chiziqcha (masalan: aziza.shifo)");
    if (f.password.length < MIN_PASSWORD) return setError(`Parol kamida ${MIN_PASSWORD} belgidan iborat bo‘lsin`);
    if (f.password !== f.repeat) return setError("Parol va uning takrori bir xil emas");
    if (!f.planCode) return setError("Tarifni tanlang");
    if (!f.acceptTerms) return setError("Foydalanish shartlari va maxfiylik siyosatiga rozilik kerak");

    setBusy(true);
    try {
      const res = await fetch("/api/signup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clinicName: f.clinicName.trim(),
          city: f.city.trim(),
          clinicPhone: f.clinicPhone.trim(),
          address: f.address.trim(),
          ownerName: f.ownerName.trim(),
          ownerPhone: f.ownerPhone.trim(),
          login,
          password: f.password,
          planCode: f.planCode,
          acceptTerms: true,
          ...(f.website ? { website: f.website } : {}),
        }),
      });
      const json = (await res.json().catch(() => null)) as { ok?: boolean; error?: string } | null;
      if (!res.ok || !json?.ok) {
        setError(json?.error ?? "Ro‘yxatdan o‘tkazib bo‘lmadi. Birozdan keyin qayta urinib ko‘ring.");
        return;
      }
      const { error: signInError } = await createClient().auth.signInWithPassword({ email: signInEmail(login), password: f.password });
      if (signInError) {
        router.push("/login");
        return;
      }
      router.push("/admin?welcome=1");
      router.refresh();
    } catch {
      setError("Tarmoq xatosi. Qayta urinib ko‘ring.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-6 rounded-3xl border border-hairline bg-surface p-5 shadow-[var(--shadow-pop)] md:p-8" noValidate>
      {error && (
        <p role="alert" className="rounded-xl bg-danger-tint px-3.5 py-2.5 text-sm font-medium text-danger">
          {error}
        </p>
      )}

      <fieldset className="flex flex-col gap-3">
        <legend className="font-display mb-1 text-base font-semibold">1. Klinika</legend>
        <Field label="Klinika nomi">
          <input className={input} value={f.clinicName} onChange={(e) => set("clinicName")(e.target.value)} placeholder="Masalan: Shifo Nur" autoComplete="organization" />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Shahar">
            <input className={input} value={f.city} onChange={(e) => set("city")(e.target.value)} placeholder="Toshkent" autoComplete="address-level2" />
          </Field>
          <Field label="Klinika telefoni">
            <input className={input} value={f.clinicPhone} onChange={(e) => set("clinicPhone")(e.target.value)} placeholder="+998 71 200 00 00" inputMode="tel" autoComplete="tel" />
          </Field>
        </div>
        <Field label="Manzil (ixtiyoriy)">
          <input className={input} value={f.address} onChange={(e) => set("address")(e.target.value)} placeholder="Ko‘cha, uy" autoComplete="street-address" />
        </Field>
      </fieldset>

      <fieldset className="flex flex-col gap-3">
        <legend className="font-display mb-1 text-base font-semibold">2. Klinika egasi (siz)</legend>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="To‘liq ism">
            <input
              className={input}
              value={f.ownerName}
              onChange={(e) => {
                set("ownerName")(e.target.value);
                if (!loginTouched) set("login")(suggestLogin(e.target.value));
              }}
              placeholder="Aziza Rahimova"
              autoComplete="name"
            />
          </Field>
          <Field label="Telefon">
            <input className={input} value={f.ownerPhone} onChange={(e) => set("ownerPhone")(e.target.value)} placeholder="+998 90 123 45 67" inputMode="tel" autoComplete="tel" />
          </Field>
        </div>
        <Field label="Login" hint="Panelga shu login bilan kirasiz. Lotin harflari, raqamlar va nuqta.">
          <input
            className={`${input} font-numeric`}
            value={f.login}
            onChange={(e) => {
              setLoginTouched(true);
              set("login")(e.target.value);
            }}
            placeholder="aziza.rahimova"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
          />
        </Field>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Parol" hint={`Kamida ${MIN_PASSWORD} belgi`}>
            <input className={input} type="password" value={f.password} onChange={(e) => set("password")(e.target.value)} autoComplete="new-password" />
          </Field>
          <Field label="Parolni takrorlang">
            <input className={input} type="password" value={f.repeat} onChange={(e) => set("repeat")(e.target.value)} autoComplete="new-password" />
          </Field>
        </div>
      </fieldset>

      {plans.length > 0 && (
        <fieldset className="flex flex-col gap-3">
          <legend className="font-display mb-1 text-base font-semibold">3. Tarif</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {plans.map((p) => (
              <label
                key={p.code}
                className={`cursor-pointer rounded-2xl border p-3.5 transition ${f.planCode === p.code ? "border-pine bg-pine-tint" : "border-hairline hover:border-pine/40"}`}
              >
                <input type="radio" name="plan" value={p.code} checked={f.planCode === p.code} onChange={() => set("planCode")(p.code)} className="sr-only" />
                <p className="font-display font-semibold">{p.name}</p>
                <p className="font-numeric mt-1 text-sm text-pine-deep">{formatUzs(p.monthlyPriceUzs)}/oy</p>
                <p className="mt-1 text-[11.5px] text-ink-muted">{p.maxStaff ? `${p.maxStaff} tagacha xodim` : "Cheksiz xodim"}</p>
              </label>
            ))}
          </div>
          <p className="text-xs text-ink-muted">Birinchi 14 kun bepul. Tarifni keyin “Obuna” bo‘limida o‘zgartirasiz.</p>
        </fieldset>
      )}

      {/* Hidden from people; bots fill it in. */}
      <input type="text" tabIndex={-1} autoComplete="off" value={f.website} onChange={(e) => set("website")(e.target.value)} className="hidden" aria-hidden />

      <label className="flex items-start gap-2.5 text-sm">
        <input type="checkbox" className="mt-1 h-4 w-4 accent-[var(--pine)]" checked={f.acceptTerms} onChange={(e) => set("acceptTerms")(e.target.checked)} />
        <span>
          Foydalanish shartlari va{" "}
          <Link href="/privacy" target="_blank" className="font-semibold text-pine hover:underline">
            maxfiylik siyosati
          </Link>
          ga roziman. Bemorlar ma’lumotlari uchun klinika javobgar; Health AI ularni faqat xizmat ko‘rsatish uchun qayta ishlaydi.
        </span>
      </label>

      <button
        type="submit"
        disabled={busy}
        className="rounded-xl bg-pine px-5 py-3 text-[15px] font-semibold text-white shadow-[0_10px_24px_-10px_rgba(11,110,92,0.8)] transition hover:bg-pine-deep disabled:opacity-60"
      >
        {busy ? "Klinika yaratilmoqda…" : "Klinikani ro‘yxatdan o‘tkazish"}
      </button>
    </form>
  );
}
