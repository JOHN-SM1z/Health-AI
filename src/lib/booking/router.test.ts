import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));

import { matchDirections, normalizeConcern, routeConcern } from "@/lib/booking/router";

/** The deterministic concern router: everyday words → directions; never routes urgent wording. */
describe("matchDirections", () => {
  it.each([
    ["Boshim og‘riyapti, ba’zan bosh aylanadi", "neurology"],
    ["бошим оғрияпти", "neurology"],
    ["Boshim kuchli og‘riyapti", "neurology"],
    ["У меня болит голова", "neurology"],
    ["Tishim og'riyapti", "dentistry"],
    ["qon bosimim ko‘tariladi", "cardiology"],
    ["Bolam yo'talyapti", "pediatrics"],
    ["ko‘zim qizarib ketdi", "ophthalmology"],
    ["quloqim og'riydi", "ent"],
    ["terimda toshma bor", "dermatology"],
    ["homiladorman, ko'rikdan o'tmoqchiman", "gynecology"],
    ["qorin og'riyapti, ich ketyapti", "gastroenterology"],
    ["qand kasalligi uchun nazorat", "endocrinology"],
    ["bel og'rig'i", "orthopedics"],
    ["qon tahlil topshirmoqchiman", "laboratory"],
  ])("%s → %s", (text, direction) => {
    expect(matchDirections(text)[0]).toBe(direction);
  });

  it("returns nothing for words it does not know (the general consultation is offered instead)", () => {
    expect(matchDirections("o‘zimni yaxshi his qilmayapman")).toEqual([]);
  });

  it("treats every apostrophe the same", () => {
    expect(normalizeConcern("og‘ri og’ri ogʻri og`ri")).toBe(" og'ri og'ri og'ri og'ri ");
  });

  it("refuses to route urgent wording — the caller escalates it", async () => {
    await expect(routeConcern("clinic", "nafas ololmayapman, tez yordam kerak")).rejects.toThrow(/urgent/);
  });
});
