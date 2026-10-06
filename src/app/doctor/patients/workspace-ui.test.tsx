// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

const api = vi.hoisted(() => ({ get: vi.fn(), post: vi.fn(), patch: vi.fn() }));
vi.mock("next/navigation", () => ({ useParams: () => ({ id: "patient" }) }));
vi.mock("@/lib/admin/client", async (original) => ({ ...await original<typeof import("@/lib/admin/client")>(), adminApi: api }));
import Page from "./[id]/page";
import { AdminApiError } from "@/lib/admin/client";
import { ReferralDialog } from "@/components/doctor/referral-dialog";

const now = "2026-09-28T10:00:00Z";
const record = (mine = true, version = 1) => ({
  id: `version-${version}`, rootRecordId: "root", version, mine, type: "assessment", summary: version === 1 ? "Original assessment" : "Current assessment",
  details: null, code: null, createdAt: now, appointmentId: "visit", author: { id: mine ? "me" : "prior", name: mine ? "Doctor B" : "Doctor A" },
  stage: "current", category: "current_assessment",
});
const workspace = (mine = true, version = 1) => ({
  patient: { id: "patient", fullName: "Synthetic patient", phone: null }, relationship: "own", referralAccessUntil: null,
  appointments: [{ id: "visit", startAt: now, status: "in_progress", mine, doctor: { id: mine ? "me" : "prior", name: "Doctor A" }, service: { name: "Consultation" } }],
  records: [record(mine, version)], referrals: [] as Array<Record<string, unknown>>,
  consultation: { current: mine ? { appointmentId: "visit", startAt: now, serviceName: "Consultation" } : null, booked: null,
    canStartWalkIn: true, blockedReason: null, services: [{ id: "service", name: "Consultation" }] },
});
beforeEach(() => { vi.resetAllMocks(); });
afterEach(cleanup);

describe("real patient workspace components", () => {
  it("edit/save shows only the current version; old content remains in read-only history", async () => {
    const user = userEvent.setup();
    let current = workspace();
    api.get.mockImplementation(async (url: string) => url.endsWith("/history") ? { history: { versions: [
      { ...record(), status: "superseded" }, { ...record(true,2), status: "current" },
    ] } } : { record: current });
    api.post.mockImplementation(async () => { current = workspace(true,2); return { record: { id: "version-2", version: 2 } }; });
    render(<Page />);
    await user.click(await screen.findByRole("button", { name: "Tahrirlash" }));
    const form = screen.getByLabelText("Yozuvni tahrirlash");
    await user.clear(within(form).getByLabelText("Qisqacha mazmun"));
    await user.type(within(form).getByLabelText("Qisqacha mazmun"), "Current assessment");
    await user.click(within(form).getByRole("button", { name: "Saqlash" }));
    await screen.findByText("Current assessment");
    expect(screen.queryByText("Original assessment")).toBeNull();
    expect(api.post).toHaveBeenCalledWith("/api/doctor/patients/patient/records/version-1/corrections", expect.objectContaining({ expectedVersion: 1, summary: "Current assessment" }));
    await user.click(screen.getByRole("button", { name: "Tarix" }));
    const history = await screen.findByRole("list", { name: "Yozuv tarixi" });
    expect(within(history).getByText("Original assessment")).toBeDefined();
    expect(within(history).getByText("Almashtirilgan")).toBeDefined();
    expect(within(history).getByText("Amaldagi")).toBeDefined();
    expect(within(history).queryAllByRole("button")).toHaveLength(0);
  });

  it("later treating doctor sees prior records with provenance and no foreign edit button", async () => {
    api.get.mockResolvedValue({ record: workspace(false,2) });
    render(<Page />);
    await screen.findByText("Current assessment");
    expect(screen.getByText(/Muallif: Doctor A/)).toBeDefined();
    expect(screen.queryByRole("button", { name: "Tahrirlash" })).toBeNull();
    expect(screen.getByRole("button", { name: "Tarix" })).toBeDefined();
  });

  it("409 preserves the unsaved draft, refreshes the version and retries against the winner", async () => {
    const user = userEvent.setup();
    let current = workspace();
    api.get.mockImplementation(async () => ({ record: current }));
    api.post.mockImplementationOnce(async () => { current = workspace(true,2); throw new AdminApiError(409,"Changed","VERSION_CONFLICT"); })
      .mockResolvedValueOnce({ record: { id: "version-3", version: 3 } });
    render(<Page />);
    await user.click(await screen.findByRole("button", { name: "Tahrirlash" }));
    const form = screen.getByLabelText("Yozuvni tahrirlash");
    await user.clear(within(form).getByLabelText("Qisqacha mazmun"));
    await user.type(within(form).getByLabelText("Qisqacha mazmun"), "Unsaved draft");
    await user.click(within(form).getByRole("button", { name: "Saqlash" }));
    await screen.findByText("Current assessment");
    expect((within(form).getByLabelText("Qisqacha mazmun") as HTMLInputElement).value).toBe("Unsaved draft");
    await user.click(within(form).getByRole("button", { name: "Saqlash" }));
    await waitFor(() => expect(api.post).toHaveBeenLastCalledWith("/api/doctor/patients/patient/records/version-2/corrections", expect.objectContaining({expectedVersion:2,summary:"Unsaved draft"})));
  });

  it("pending handoff shows history and enables consultation start without acceptance", async () => {
    const user = userEvent.setup();
    const current = workspace(false,2);
    current.relationship = "referred";
    current.referrals = [{ id:"referral",role:"receiver",status:"pending",priority:"routine",reason:"Review",createdAt:now,expiresAt:"2026-12-01T00:00:00Z",referringDoctor:{id:"prior",name:"Doctor A"} }];
    api.get.mockResolvedValue({ record: current }); api.post.mockResolvedValue({});
    render(<Page />);
    await screen.findByText("Current assessment");
    await user.selectOptions(screen.getByRole("combobox",{name:"Xizmat"}),"service");
    await user.click(screen.getByRole("button",{name:"Hozir qabulni boshlash"}));
    expect(api.post).toHaveBeenCalledWith("/api/doctor/patients/patient/consultations",{serviceId:"service"});
    expect(api.patch).not.toHaveBeenCalled();
  });

  it("referral creation filters existing doctors by department and sends the existing consultation", async () => {
    const user=userEvent.setup(); const onCreated=vi.fn();
    api.get.mockResolvedValue({doctors:[{id:"cardio",name:"Cardiologist",specialty:"Cardiology"},{id:"neuro",name:"Neurologist",specialty:"Neurology"}]});
    api.post.mockResolvedValue({referral:{id:"new-referral"}});
    render(<ReferralDialog consultation={{appointmentId:"visit",startAt:now,serviceName:"Consultation"}} patientName="Synthetic patient" onClose={vi.fn()} onCreated={onCreated} />);
    await user.selectOptions(await screen.findByRole("combobox",{name:"Bo‘lim / mutaxassislik"}),"Cardiology");
    expect(screen.queryByRole("option",{name:/Neurologist/})).toBeNull();
    await user.selectOptions(screen.getByRole("combobox",{name:"Qabul qiluvchi shifokor"}),"cardio");
    await user.type(screen.getByLabelText("Yo‘llanma sababi"),"Specialist review");
    await user.click(screen.getByRole("button",{name:"Ko‘rib chiqish"}));
    await user.click(screen.getByRole("button",{name:"Yo‘llanma yuborish"}));
    expect(api.post).toHaveBeenCalledWith("/api/doctor/referrals",expect.objectContaining({appointmentId:"visit",referredToDoctorId:"cardio",reason:"Specialist review"}));
    expect(onCreated).toHaveBeenCalledWith("new-referral");
  });
});
