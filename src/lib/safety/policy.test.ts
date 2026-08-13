import { describe, it, expect } from "vitest";
import {
  detectUrgency,
  deterministicRoute,
  containsDisallowedClaim,
  assertSafeAiOutput,
  urgentMessage,
  URGENT_MESSAGE_UZ,
  URGENT_MESSAGE_RU,
} from "@/lib/safety/policy";

describe("detectUrgency", () => {
  it("flags Uzbek urgent phrases", () => {
    expect(detectUrgency("tez yordam chaqiring")).toBe("urgent");
    expect(detectUrgency("onam hushidan ketdi")).toBe("urgent");
    expect(detectUrgency("qattiq og'riq boshladi")).toBe("urgent");
    expect(detectUrgency("ko'krak og'rig'i bor")).toBe("urgent");
    expect(detectUrgency("nafas olish qiyin")).toBe("urgent");
    expect(detectUrgency("qon ketish to'xtamayapti")).toBe("urgent");
    expect(detectUrgency("yurak xuruji bo'ldi")).toBe("urgent");
  });

  it("flags Russian urgent phrases", () => {
    expect(detectUrgency("вызовите скорую")).toBe("urgent");
    expect(detectUrgency("срочно нужна помощь")).toBe("urgent");
    expect(detectUrgency("потерял сознание")).toBe("urgent");
    expect(detectUrgency("кровотечение не останавливается")).toBe("urgent");
  });

  it("flags English urgent phrases", () => {
    expect(detectUrgency("this is an emergency")).toBe("urgent");
    expect(detectUrgency("chest pain right now")).toBe("urgent");
    expect(detectUrgency("he had a heart attack")).toBe("urgent");
  });

  it("does not flag routine booking questions", () => {
    expect(detectUrgency("qabulga yozilmoqchiman")).toBe("none");
    expect(detectUrgency("narxlari qanday?")).toBe("none");
    expect(detectUrgency("shifokor qaysi kunlari qabul qiladi?")).toBe("none");
    expect(detectUrgency("")).toBe("none");
  });

  it("flags near-miss spellings of ko'krak og'rig'i", () => {
    expect(detectUrgency("ko`krak og`rig`i")).toBe("none"); // typographic apostrophes not covered — safe default
    expect(detectUrgency("ko'krak og'rig'i kuchaydi")).toBe("urgent");
  });
});

describe("urgentMessage", () => {
  it("returns the Russian message for Cyrillic input and Uzbek otherwise", () => {
    expect(urgentMessage("нужна скорая")).toBe(URGENT_MESSAGE_RU);
    expect(urgentMessage("tez yordam kerak")).toBe(URGENT_MESSAGE_UZ);
  });
});

describe("deterministicRoute", () => {
  it("routes urgency to urgent, operator requests to human, else AI", () => {
    expect(deterministicRoute("shoshilinch")).toBe("urgent");
    expect(deterministicRoute("operator bilan bog'lang")).toBe("human");
    expect(deterministicRoute("нужен человек")).toBe("human");
    expect(deterministicRoute("narx qancha?")).toBe("ai");
  });
});

describe("containsDisallowedClaim / assertSafeAiOutput", () => {
  it("blocks diagnosis and prescription claims", () => {
    expect(containsDisallowedClaim("Bu tashxis: sizda pnevmoniya")).toBe(true);
    expect(containsDisallowedClaim("Sizga antibiotik kerak")).toBe(true);
    expect(containsDisallowedClaim("Kasalligingiz davolanish talab qiladi")).toBe(true);
    expect(containsDisallowedClaim("I diagnose you with diabetes")).toBe(true);
    expect(containsDisallowedClaim("You don't need a doctor")).toBe(true);
  });

  it("allows booking-related output", () => {
    expect(assertSafeAiOutput("Terapevtga yozilishingiz mumkin, ertaga 10:00 da bo'sh vaqt bor.")).toBe(true);
    expect(assertSafeAiOutput("Klinikamiz 09:00 dan 18:00 gacha ochiq.")).toBe(true);
  });
});