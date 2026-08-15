import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

vi.mock("server-only", () => ({}));

const mockClinic = {
  id: "clinic-uuid-1",
  name: "Health AI Clinic",
  timezone: "Asia/Tashkent",
  currency: "UZS",
  phone: "+998712000000",
  address: "Tashkent, Amir Temur 1",
  opening_hours: { mon: "09:00-18:00" },
};

const mockServices = [
  {
    id: "service-1",
    name: "Konsultatsiya",
    description: "Shifokor ko‘rigi",
    price: 150000,
    duration_minutes: 30,
    preparation_text: null,
    specialty_id: "spec-1",
  },
];

const mockDoctors = [
  {
    id: "doc-1",
    name: "Dr. Aliyev",
    title: "Kardiolog",
    specialty_id: "spec-1",
  },
];

const mockSpecialties = [
  {
    id: "spec-1",
    name: "Kardiologiya",
  },
];

const supabaseMock = {
  from: vi.fn((table: string) => {
    if (table === "services") {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(() => ({
              order: vi.fn(async () => ({ data: mockServices, error: null })),
            })),
          })),
        })),
      };
    }
    if (table === "doctors") {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(async () => ({ data: mockDoctors, error: null })),
          })),
        })),
      };
    }
    if (table === "specialties") {
      return {
        select: vi.fn(() => ({
          eq: vi.fn(() => ({
            eq: vi.fn(() => ({
              order: vi.fn(async () => ({ data: mockSpecialties, error: null })),
            })),
          })),
        })),
      };
    }
    if (table === "doctor_services") {
      return {
        select: vi.fn(() => ({
          in: vi.fn(async () => ({ data: [{ doctor_id: "doc-1", service_id: "service-1" }], error: null })),
        })),
      };
    }
    return {};
  }),
};

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => supabaseMock,
}));

vi.mock("@/lib/clinics/context", () => ({
  getDefaultClinic: async () => mockClinic,
}));

import { GET, POST } from "./route";

describe("Catalog Route (GET & POST)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("GET returns active catalog with clinic, services, doctors, and specialties", async () => {
    const req = new NextRequest("http://localhost:3000/api/catalog");
    const res = await GET(req);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.clinic.id).toBe("clinic-uuid-1");
    expect(json.data.services).toHaveLength(1);
    expect(json.data.doctors).toHaveLength(1);
    expect(json.data.specialties).toHaveLength(1);
  });

  it("POST returns the identical catalog payload for client SDK compatibility", async () => {
    const req = new NextRequest("http://localhost:3000/api/catalog", {
      method: "POST",
      body: JSON.stringify({ initData: "test" }),
    });
    const res = await POST(req);
    expect(res.status).toBe(200);

    const json = await res.json();
    expect(json.ok).toBe(true);
    expect(json.data.clinic.name).toBe("Health AI Clinic");
  });
});
