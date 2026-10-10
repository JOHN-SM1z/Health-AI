import { describe, expect, it } from "vitest";
import { checkPinflAgainstBirthDate, pinflBirthDate, pinflSex } from "./pinfl";

// Illustrative numbers built from the published structure, not real people.
const MAN_1987 = "31403870120015"; // 3 = male, 1900s; 14.03.87
const WOMAN_2001 = "60512010340027"; // 6 = female, 2000s; 05.12.01

describe("JSHSHIR structure", () => {
  it("reads the date of birth and sex", () => {
    expect(pinflBirthDate(MAN_1987)).toBe("1987-03-14");
    expect(pinflSex(MAN_1987)).toBe("male");
    expect(pinflBirthDate(WOMAN_2001)).toBe("2001-12-05");
    expect(pinflSex(WOMAN_2001)).toBe("female");
  });

  it("accepts the JSHSHIR only with its own date of birth", () => {
    expect(checkPinflAgainstBirthDate(MAN_1987, "1987-03-14")).toBe("ok");
    expect(checkPinflAgainstBirthDate(MAN_1987, "1987-04-14")).toBe("birth_date_mismatch");
    expect(checkPinflAgainstBirthDate(MAN_1987, "2087-03-14")).toBe("birth_date_mismatch");
  });

  it("rejects impossible numbers: unknown century digit, a day that does not exist, wrong length", () => {
    expect(checkPinflAgainstBirthDate("71403870120015", "1987-03-14")).toBe("invalid");
    expect(checkPinflAgainstBirthDate("33102870120015", "1987-02-31")).toBe("invalid");
    expect(checkPinflAgainstBirthDate("3140387012001", "1987-03-14")).toBe("invalid");
    expect(pinflSex("01403870120015")).toBeNull();
  });
});
