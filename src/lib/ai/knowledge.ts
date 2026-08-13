import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";

export type ClinicKnowledge = {
  clinicName: string;
  address: string | null;
  phone: string | null;
  email: string | null;
  openingHours: Record<string, string | null>;
  currency: string;
  faqs: Array<{ question: string; answer: string }>;
  specialties: Array<{ name: string; description: string | null }>;
  services: Array<{ name: string; description: string | null; price: number; durationMinutes: number; preparationText: string | null; specialty: string | null }>;
  doctors: Array<{ name: string; title: string | null; specialty: string | null }>;
};

/** Loads the approved, database-sourced knowledge for the AI receptionist. */
export async function loadClinicKnowledge(clinicId: string): Promise<ClinicKnowledge> {
  const supabase = createAdminClient();

  const [{ data: clinic }, { data: faqs }, { data: specialties }, { data: services }, { data: doctors }] =
    await Promise.all([
      supabase.from("clinics").select("*").eq("id", clinicId).maybeSingle(),
      supabase
        .from("faq_entries")
        .select("question, answer")
        .eq("clinic_id", clinicId)
        .eq("active", true)
        .order("sort_order"),
      supabase
        .from("specialties")
        .select("name, description")
        .eq("clinic_id", clinicId)
        .eq("active", true)
        .order("sort_order"),
      supabase
        .from("services")
        .select("name, description, price, duration_minutes, preparation_text, specialties(name)")
        .eq("clinic_id", clinicId)
        .eq("active", true)
        .order("sort_order"),
      supabase
        .from("doctors")
        .select("name, title, specialties(name)")
        .eq("clinic_id", clinicId)
        .eq("active", true),
    ]);

  const knowledge: ClinicKnowledge = {
    clinicName: clinic?.name ?? "Klinika",
    address: clinic?.address ?? null,
    phone: clinic?.phone ?? null,
    email: clinic?.email ?? null,
    openingHours: (clinic?.opening_hours as Record<string, string | null>) ?? {},
    currency: clinic?.currency ?? "UZS",
    faqs: (faqs ?? []).map((f) => ({ question: f.question, answer: f.answer })),
    specialties: (specialties ?? []).map((s) => ({ name: s.name, description: s.description })),
    services: (services ?? []).map((s) => ({
      name: s.name,
      description: s.description,
      price: Number(s.price),
      durationMinutes: s.duration_minutes,
      preparationText: s.preparation_text,
      specialty: s.specialties?.name ?? null,
    })),
    doctors: (doctors ?? []).map((d) => ({
      name: d.name,
      title: d.title,
      specialty: d.specialties?.name ?? null,
    })),
  };

  return knowledge;
}

function renderKnowledge(k: ClinicKnowledge): string {
  const lines: string[] = [];
  lines.push(`Klinika: ${k.clinicName}`);
  if (k.address) lines.push(`Manzil: ${k.address}`);
  if (k.phone) lines.push(`Telefon: ${k.phone}`);
  if (k.email) lines.push(`Email: ${k.email}`);
  const hours = Object.entries(k.openingHours)
    .map(([day, h]) => `${day}: ${h ?? "yopiq"}`)
    .join(", ");
  if (hours) lines.push(`Ish vaqti: ${hours}`);
  lines.push(`Pul birligi: ${k.currency}`);

  if (k.specialties.length) {
    lines.push("\nYo‘nalishlar:");
    for (const s of k.specialties) lines.push(`- ${s.name}${s.description ? `: ${s.description}` : ""}`);
  }
  if (k.doctors.length) {
    lines.push("\nShifokorlar:");
    for (const d of k.doctors)
      lines.push(`- ${d.name}${d.title ? ` (${d.title})` : ""}${d.specialty ? ` — ${d.specialty}` : ""}`);
  }
  if (k.services.length) {
    lines.push("\nXizmatlar va narxlar:");
    for (const s of k.services)
      lines.push(
        `- ${s.name}${s.specialty ? ` [${s.specialty}]` : ""}: ${s.price} ${k.currency}, ${s.durationMinutes} daqiqa${s.preparationText ? `. Tayyorgarlik: ${s.preparationText}` : ""}`,
      );
  }
  if (k.faqs.length) {
    lines.push("\nRasmiy FAQ:");
    for (const f of k.faqs) lines.push(`Q: ${f.question}\nA: ${f.answer}`);
  }
  return lines.join("\n");
}

export function buildReceptionistSystemPrompt(k: ClinicKnowledge): string {
  return [
    "Siz klinika qabulxona yordamchisisiz (AI receptionist).",
    "QAT'IY QOIDALAR:",
    "1. FAQAT quyida berilgan KLINIKA MA'LUMOTLARI asosida javob bering. Hech qachon ma'lumot uydirma qilmang.",
    "2. Tibbiy tashxis QO'YMANG, davolash yoki dori tavsiya qilmang. Agar bemor alomatlarini aytib, qaysi shifokorga murojaat qilishni so'rasa, yo'nalish (specialty) taklif qiling, kasallik emas.",
    "3. Agar javob ma'lumotlarda bo'lmasa: 'Afsuski, bu savolga aniq javob bera olmayman. Operatorlarimiz sizga yordam berishi mumkin — “Operator bilan bog‘lanish” tugmasini bosing.' deb yozing.",
    "4. Shoshilinch holatlarda: 'Bu holat shoshilinch yordam talab qilishi mumkin. Iltimos, mahalliy tez yordam xizmatiga murojaat qiling yoki zudlik bilan shifokorga boring.' deb yozing.",
    "5. Qisqa va aniq javob bering. Uzbek lotin tilida yozing.",
    "6. Qabulga yozilishni taklif qilganda “Qabulga yozilish” tugmasidan foydalanishni eslatib o'ting.",
    "",
    "KLINIKA MA'LUMOTLARI (faqat shu manbadan foydalaning):",
    renderKnowledge(k),
  ].join("\n");
}