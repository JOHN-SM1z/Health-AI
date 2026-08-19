import { createClient } from "@supabase/supabase-js";
import { z } from "zod";

const envSchema = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(10),
  CLINIC_SLUG: z.string().default("health-ai-clinic"),
});

const env = envSchema.parse(process.env);
const supabase = createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
});

async function main() {
  console.log("Klinika katalogini to'ldirish boshlandi…");

  const { data: clinic } = await supabase
    .from("clinics")
    .select("id, name, slug")
    .eq("slug", env.CLINIC_SLUG)
    .single();

  if (!clinic) {
    console.error("Klinika topilmadi");
    process.exit(1);
  }

  const clinicId = clinic.id;
  console.log(`✓ Klinika: ${clinic.name} (${clinicId})`);

  // 1. Specialties
  const specialtiesData = [
    { clinic_id: clinicId, name: "Terapiya", description: "Umumiy terapiya — katta yoshli bemorlar uchun", sort_order: 1 },
    { clinic_id: clinicId, name: "Kardiologiya", description: "Yurak va qon-tomir kasalliklari", sort_order: 2 },
    { clinic_id: clinicId, name: "Dermatologiya", description: "Teri kasalliklari", sort_order: 3 },
    { clinic_id: clinicId, name: "Pediatriya", description: "Bolalar salomatligi", sort_order: 4 },
  ];

  for (const spec of specialtiesData) {
    const { data: existing } = await supabase
      .from("specialties")
      .select("id")
      .eq("clinic_id", clinicId)
      .eq("name", spec.name)
      .maybeSingle();
    if (!existing) {
      await supabase.from("specialties").insert(spec);
    }
  }

  const { data: specs } = await supabase.from("specialties").select("id, name").eq("clinic_id", clinicId);
  const specMap = new Map((specs ?? []).map((s) => [s.name, s.id]));
  console.log(`✓ ${specs?.length ?? 0} mutaxassislik mavjud`);

  // 2. Services
  const servicesData = [
    { clinic_id: clinicId, specialty_id: specMap.get("Terapiya"), name: "Terapevt qabuli", description: "Umumiy shifokor ko‘rigi", duration_minutes: 20, price: 150000, sort_order: 1 },
    { clinic_id: clinicId, specialty_id: specMap.get("Kardiologiya"), name: "Kardiolog qabuli", description: "Kardiolog bilan konsultatsiya", duration_minutes: 30, price: 250000, preparation_text: "Qon bosimi o‘lchangan holda keling", sort_order: 2 },
    { clinic_id: clinicId, specialty_id: specMap.get("Dermatologiya"), name: "Dermatolog qabuli", description: "Teri kasalliklari bo‘yicha konsultatsiya", duration_minutes: 30, price: 200000, sort_order: 3 },
    { clinic_id: clinicId, specialty_id: specMap.get("Pediatriya"), name: "Pediatr qabuli", description: "Bola shifokori ko‘rigi", duration_minutes: 20, price: 180000, sort_order: 4 },
    { clinic_id: clinicId, specialty_id: null, name: "Umumiy konsultatsiya", description: "Yo‘nalish aniq bo‘lmaganda umumiy qabul", duration_minutes: 20, price: 120000, sort_order: 5 },
  ];

  for (const serv of servicesData) {
    const { data: existing } = await supabase
      .from("services")
      .select("id")
      .eq("clinic_id", clinicId)
      .eq("name", serv.name)
      .maybeSingle();
    if (!existing) {
      await supabase.from("services").insert(serv);
    }
  }

  const { data: services } = await supabase.from("services").select("id, name").eq("clinic_id", clinicId);
  const servMap = new Map((services ?? []).map((s) => [s.name, s.id]));
  console.log(`✓ ${services?.length ?? 0} xizmat mavjud`);

  // 3. Doctors
  const doctorsData = [
    { clinic_id: clinicId, specialty_id: specMap.get("Terapiya"), name: "Karimov Alisher", title: "Terapevt, 1-toifa", bio: "15 yillik tajriba", active: true },
    { clinic_id: clinicId, specialty_id: specMap.get("Kardiologiya"), name: "Rahimova Dilnoza", title: "Kardiolog", bio: "10 yillik tajriba", active: true },
    { clinic_id: clinicId, specialty_id: specMap.get("Pediatriya"), name: "Yusupova Malika", title: "Pediatr", bio: "8 yillik tajriba", active: true },
  ];

  for (const doc of doctorsData) {
    const { data: existing } = await supabase
      .from("doctors")
      .select("id")
      .eq("clinic_id", clinicId)
      .eq("name", doc.name)
      .maybeSingle();
    if (!existing) {
      await supabase.from("doctors").insert(doc);
    }
  }

  const { data: doctors } = await supabase.from("doctors").select("id, name, specialty_id").eq("clinic_id", clinicId);
  console.log(`✓ ${doctors?.length ?? 0} shifokor mavjud`);

  // 4. Doctor Services Link & Working Hours
  if (doctors && services) {
    for (const d of doctors) {
      for (const s of services) {
        await supabase
          .from("doctor_services")
          .upsert({ doctor_id: d.id, service_id: s.id }, { onConflict: "doctor_id,service_id" });
      }

      // Working hours
      for (let w = 1; w <= 5; w++) {
        await supabase
          .from("doctor_working_hours")
          .upsert(
            { clinic_id: clinicId, doctor_id: d.id, weekday: w, start_time: "09:00", end_time: "18:00" },
            { onConflict: "doctor_id,weekday" },
          );
      }
      await supabase
        .from("doctor_working_hours")
        .upsert(
          { clinic_id: clinicId, doctor_id: d.id, weekday: 6, start_time: "09:00", end_time: "14:00" },
          { onConflict: "doctor_id,weekday" },
        );
    }
    console.log("✓ Shifokorlar va ish vaqtlari biriktirildi");
  }

  console.log("\nKatalog to'liq tayyor!");
}

main().catch(console.error);
