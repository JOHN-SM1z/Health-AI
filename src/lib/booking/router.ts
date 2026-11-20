import "server-only";
import { createAdminClient } from "@/lib/supabase/admin";
import { detectUrgency } from "@/lib/safety/policy";

/**
 * Concern → direction, for the Mini App booking (Slice B, owner decision 2026-10-08: the AI suggests, the patient
 * confirms). Deterministic and local: everyday words (Uzbek Latin and Cyrillic, Russian) point to a DIRECTION the clinic
 * actually has — never a disease, a cause, a test result or a treatment. Nothing leaves the server. Urgent wording is
 * the caller's to escalate before this runs; routeConcern refuses to route it.
 *
 * Each direction lists the words a patient uses ("cues") and how a clinic names that direction ("names"). A direction
 * is suggested only when the clinic has a specialty whose name matches.
 */
type Direction = { key: string; names: RegExp; cues: string[] };

const DIRECTIONS: Direction[] = [
  { key: "cardiology", names: /kardio|кардио|yurak|юрак/i, cues: ["yurak", "юрак", "сердц", "qon bosim", "қон босим", "давлени", "bosimim", "босимим", "yurak urishi"] },
  { key: "neurology", names: /nevro|невро|asab|асаб/i, cues: ["bosh og'ri", "бош оғри", "голов", "bosh aylan", "бош айлан", "головокруж", "uyqusiz", "уйқусиз", "бессон", "asab", "асаб", "нерв", "uvishi", "увиши", "онемен"] },
  { key: "dentistry", names: /stomat|стомат|tish|тиш/i, cues: ["tish", "тиш", "зуб", "milk", "дёсн", "десн"] },
  { key: "pediatrics", names: /pediat|педиат|bolalar|болалар/i, cues: ["bolam", "болам", "bola ", "бола ", "farzand", "фарзанд", "chaqaloq", "чақалоқ", "ребён", "ребен", "детск", "сын ", "дочь"] },
  { key: "ophthalmology", names: /oftalm|офтальм|ko'z|кўз|окулист/i, cues: ["ko'z", "кўз", "глаз", "ko'rish", "кўриш", "зрени"] },
  { key: "ent", names: /\blor\b|\bлор\b|otorin|оторин|quloq|қулоқ/i, cues: ["quloq", "қулоқ", "ухо", "уши", "burun", "бурун", "нос", "tomoq", "томоқ", "горл"] },
  { key: "dermatology", names: /derma|дерма|teri|тери/i, cues: ["teri", "тери", "кож", "toshma", "тошма", "сып", "qichi", "қичи", "зуд", "husnbuzar", "акне", "soch to'kil", "выпадени"] },
  { key: "gynecology", names: /ginek|гинек|akush|акуш/i, cues: ["homilador", "ҳомиладор", "беремен", "hayz", "ҳайз", "менстр", "ayollar", "аёллар", "женск"] },
  { key: "urology", names: /urolog|уролог/i, cues: ["siydik", "сийдик", "моч", "buyrak", "буйрак", "почк", "prostat", "простат"] },
  { key: "gastroenterology", names: /gastro|гастро/i, cues: ["oshqozon", "ошқозон", "желуд", "qorin", "қорин", "живот", "ich ket", "ич кет", "ich qot", "ич қот", "понос", "запор", "jig'ildon", "жиғилдон", "изжог"] },
  { key: "endocrinology", names: /endokrin|эндокрин/i, cues: ["qand", "қанд", "сахар", "диабет", "qalqonsimon", "қалқонсимон", "щитовид", "gormon", "гормон"] },
  { key: "orthopedics", names: /travmat|травмат|ortoped|ортопед/i, cues: ["suyak", "суяк", "кост", "bo'g'im", "бўғим", "сустав", "bel og'ri", "бел оғри", "поясниц", "umurtqa", "умуртқа", "позвоноч", "lat ye", "лат е", "ушиб", "chiqib ket", "чиқиб кет", "вывих"] },
  { key: "laboratory", names: /laborator|лаборатор|tahlil|таҳлил|анализ/i, cues: ["tahlil", "таҳлил", "анализ", "qon topshir", "қон топшир", "сдать кровь"] },
];

/** The clinic's general consultation, when nothing matches or the patient does not know. */
const GENERAL = /terapev|терапев|umumiy|умумий|oilaviy|оилавий|семейн/i;

/** Lower case, one apostrophe, single spaces — "Bosh og‘rig‘i" and "бош оғриғи" match their cues. */
export function normalizeConcern(text: string): string {
  return ` ${text
    .normalize("NFKC")
    .toLocaleLowerCase("uz")
    .replace(/[‘’ʻʼ`ʼ]/g, "'")
    .replace(/\s+/g, " ")
    .trim()} `;
}

export type Suggestion = { specialtyId: string; name: string; serviceIds: string[]; doctorIds: string[] };
export type RouteResult = { suggestions: Suggestion[]; general: Suggestion | null; matched: boolean };

/**
 * A cue as a pattern: each word may carry suffixes and one word may come between ("bosh og'ri" matches "boshim
 * og'riyapti" and "boshim kuchli og'riyapti").
 */
const cuePattern = (cue: string) =>
  new RegExp(cue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/ (?=\S)/g, "\\S*\\s+(?:\\S+\\s+)?"), "u");
const PATTERNS = new Map(DIRECTIONS.map((d) => [d.key, d.cues.map(cuePattern)]));

/** Directions whose cues appear in the text, in order of how many cues matched. Pure — tested without a database. */
export function matchDirections(text: string): string[] {
  const t = normalizeConcern(text);
  return DIRECTIONS.map((d) => ({ key: d.key, hits: PATTERNS.get(d.key)!.filter((re) => re.test(t)).length }))
    .filter((d) => d.hits > 0)
    .sort((a, b) => b.hits - a.hits)
    .map((d) => d.key);
}

/**
 * 1–3 of the clinic's own specialties for this concern, with their services and doctors, plus the general
 * consultation. Urgent wording is refused here: the caller escalates it and offers no booking.
 */
export async function routeConcern(clinicId: string, text: string): Promise<RouteResult> {
  if (detectUrgency(text) === "urgent") throw new Error("urgent concerns are escalated, never routed");
  const db = createAdminClient();
  const [specialties, services, doctors] = await Promise.all([
    db.from("specialties").select("id, name").eq("clinic_id", clinicId).eq("active", true),
    db.from("services").select("id, specialty_id").eq("clinic_id", clinicId).eq("active", true),
    db.from("doctors").select("id, specialty_id").eq("clinic_id", clinicId).eq("active", true),
  ]);
  // Only this clinic's doctors' links (doctor_services has no clinic of its own).
  const offered = await db
    .from("doctor_services")
    .select("doctor_id, service_id")
    .in("doctor_id", (doctors.data ?? []).map((d) => d.id));
  const specs = specialties.data ?? [];
  const toSuggestion = (s: { id: string; name: string }): Suggestion => {
    const serviceIds = (services.data ?? []).filter((x) => x.specialty_id === s.id).map((x) => x.id);
    const byService = new Set((offered.data ?? []).filter((o) => serviceIds.includes(o.service_id)).map((o) => o.doctor_id));
    const doctorIds = (doctors.data ?? []).filter((d) => d.specialty_id === s.id || byService.has(d.id)).map((d) => d.id);
    return { specialtyId: s.id, name: s.name, serviceIds, doctorIds };
  };
  const bookable = (s: Suggestion) => s.serviceIds.length > 0;

  const seen = new Set<string>();
  const suggestions: Suggestion[] = [];
  for (const key of matchDirections(text)) {
    const direction = DIRECTIONS.find((d) => d.key === key)!;
    for (const s of specs.filter((x) => direction.names.test(x.name) && !seen.has(x.id))) {
      const suggestion = toSuggestion(s);
      if (!bookable(suggestion)) continue;
      seen.add(s.id);
      suggestions.push(suggestion);
    }
  }
  const generalSpec = specs.find((s) => GENERAL.test(s.name));
  const general = generalSpec ? toSuggestion(generalSpec) : null;
  return { suggestions: suggestions.slice(0, 3), general: general && bookable(general) ? general : null, matched: suggestions.length > 0 };
}
