import { describe, expect, it } from "vitest";
import { sniffLabDocumentType } from "@/lib/labs/file-type";

const bytes = (...b: number[]) => new Uint8Array(b);
const text = (s: string) => new TextEncoder().encode(s);

describe("sniffLabDocumentType", () => {
  it("recognises PDF, JPEG, PNG and WebP by their bytes", () => {
    expect(sniffLabDocumentType(text("%PDF-1.7\n..."))).toBe("application/pdf");
    expect(sniffLabDocumentType(bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0x10))).toBe("image/jpeg");
    expect(sniffLabDocumentType(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0))).toBe("image/png");
    expect(sniffLabDocumentType(new Uint8Array([...text("RIFF"), 0, 0, 0, 0, ...text("WEBPVP8 ")]))).toBe("image/webp");
  });

  it("refuses everything else, whatever it is called", () => {
    for (const bad of [
      text("MZ\x90\x00 executable"),
      text("<!doctype html><script>alert(1)</script>"),
      text("<svg xmlns='http://www.w3.org/2000/svg'/>"),
      text("%PD"), // truncated
      new Uint8Array([...text("RIFF"), 0, 0, 0, 0, ...text("WAVE")]),
      new Uint8Array(0),
    ]) {
      expect(sniffLabDocumentType(bad)).toBeNull();
    }
  });
});
