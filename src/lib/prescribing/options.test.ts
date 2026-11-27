import { describe, expect, it } from "vitest";
import { courseQuantity, drugLabel, timesPerDay } from "./options";

/**
 * The only arithmetic on the prescribing screen: the default course quantity
 * (dose × times a day × days). It must be exact, and it must give nothing
 * rather than a guess when the frequency is the doctor's own wording.
 */
describe("prescribing options", () => {
  it("reads times a day only from an N×1 chip", () => {
    expect(timesPerDay("1×1")).toBe(1);
    expect(timesPerDay("3×1")).toBe(3);
    expect(timesPerDay(" 4 x 1 ")).toBe(4);
    expect(timesPerDay("har 8 soatda")).toBeNull();
    expect(timesPerDay("1×3")).toBeNull();
    expect(timesPerDay("0×1")).toBeNull();
    expect(timesPerDay("25×1")).toBeNull();
    expect(timesPerDay("")).toBeNull();
  });

  it("computes the course quantity exactly", () => {
    expect(courseQuantity(1, "3×1", 7)).toBe(21);
    expect(courseQuantity(0.5, "2×1", 5)).toBe(5);
    expect(courseQuantity(2.5, "3×1", 10)).toBe(75);
    // No floating-point dust on a figure the doctor signs.
    expect(courseQuantity(0.1, "3×1", 1)).toBe(0.3);
  });

  it("gives no quantity instead of a guess", () => {
    expect(courseQuantity(1, "har 8 soatda", 7)).toBeNull();
    expect(courseQuantity(0, "3×1", 7)).toBeNull();
    expect(courseQuantity(-1, "3×1", 7)).toBeNull();
    expect(courseQuantity(Number.NaN, "3×1", 7)).toBeNull();
    expect(courseQuantity(1, "3×1", 0)).toBeNull();
    expect(courseQuantity(1, "3×1", 2.5)).toBeNull();
    expect(courseQuantity(50_000, "4×1", 365)).toBeNull(); // beyond anything a prescription holds
  });

  it("labels a medicine INN first", () => {
    expect(drugLabel({ inn: "Amoksitsillin", tradeName: "Amoxil", form: "kapsula", strength: "500 mg" })).toBe("Amoksitsillin · Amoxil · kapsula 500 mg");
    expect(drugLabel({ inn: "Amoksitsillin", tradeName: null, form: null, strength: "500 mg" })).toBe("Amoksitsillin · 500 mg");
    expect(drugLabel({ inn: "Amoksitsillin" })).toBe("Amoksitsillin");
  });
});
