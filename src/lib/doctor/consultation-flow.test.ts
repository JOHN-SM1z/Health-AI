import { describe, it, expect } from "vitest";
import { nextConsultationStep } from "@/lib/doctor/consultation-flow";

describe("nextConsultationStep", () => {
  it("moves pending straight to checked_in (\"Keldi\")", () => {
    expect(nextConsultationStep("pending")).toEqual({ status: "checked_in", label: "Keldi" });
  });

  it("moves confirmed straight to checked_in (\"Keldi\") too — same one-step arrival action regardless of confirmation", () => {
    expect(nextConsultationStep("confirmed")).toEqual({ status: "checked_in", label: "Keldi" });
  });

  it("moves checked_in to in_progress (\"Qabulni boshlash\")", () => {
    expect(nextConsultationStep("checked_in")).toEqual({ status: "in_progress", label: "Qabulni boshlash" });
  });

  it("moves in_progress to completed (\"Qabulni yakunlash\")", () => {
    expect(nextConsultationStep("in_progress")).toEqual({ status: "completed", label: "Qabulni yakunlash" });
  });

  it("has no next step once terminal", () => {
    expect(nextConsultationStep("completed")).toBeNull();
    expect(nextConsultationStep("cancelled")).toBeNull();
    expect(nextConsultationStep("no_show")).toBeNull();
  });
});
