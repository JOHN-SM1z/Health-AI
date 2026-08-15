"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/browser";
import { PageHeader, Card, ABadge, ATable, AEmpty, AError, AButton, AInput, LoadingRow } from "@/components/admin/ui";
import { CalendarRange } from "lucide-react";
import { adminApi, AdminApiError, formatDateTime } from "@/lib/admin/client";

const WEEKDAYS = ["Dushanba", "Seshanba", "Chorshanba", "Payshanba", "Juma", "Shanba", "Yakshanba"];

type Block = { id: string; starts_at: string; ends_at: string; reason: string | null; note: string | null };

export default function DoctorSchedulePage() {
  const [doctorId, setDoctorId] = useState<string | null>(null);
  const [hours, setHours] = useState<{ weekday: number; start_time: string; end_time: string }[] | null>(null);
  const [blocks, setBlocks] = useState<Block[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");

  const load = async () => {
    const supabase = createClient();
    const authData = await supabase.auth.getUser();
    const uid = authData.data.user?.id;

    const { data: doctor } = await supabase
      .from("doctors")
      .select("id")
      .eq("profile_id", uid ?? "")
      .maybeSingle();
    if (!doctor) {
      setDoctorId(null);
      return;
    }
    setDoctorId(doctor.id);

    const [{ data: wh }, { data: bl }] = await Promise.all([
      supabase.from("doctor_working_hours").select("weekday, start_time, end_time").eq("doctor_id", doctor.id).order("weekday"),
      supabase.from("doctor_time_blocks").select("*").eq("doctor_id", doctor.id).gte("ends_at", new Date().toISOString()).order("starts_at"),
    ]);
    setHours(wh ?? []);
    setBlocks(bl ?? []);
  };

  useEffect(() => {
    void load();
  }, []);

  const addBreak = async () => {
    if (!start || !end) {
      setError("Boshlanish va tugash vaqtini kiriting");
      return;
    }
    try {
      await adminApi.post("/api/doctor/appointments", { startsAt: new Date(start).toISOString(), endsAt: new Date(end).toISOString(), reason: "break" });
      setStart("");
      setEnd("");
      setError(null);
      void load();
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : "Xatolik");
    }
  };

  const deleteBlock = async (id: string) => {
    await adminApi.del(`/api/admin/doctors/${id}`).catch(() => undefined);
    void load();
  };

  return (
    <div>
      <PageHeader title="Jadvalim" subtitle="Haftalik ish vaqti va tanaffuslar" />
      {error && <AError message={error} />}

      {doctorId === null ? (
        <Card>
          <AEmpty
            title="Shifokor hisobi ulanmagan"
            subtitle="Admin panelda shifokor kartasiga profilingizni bog‘lang."
            icon={<CalendarRange className="h-6 w-6" />}
          />
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          <Card>
            <p className="mb-3 text-sm font-bold text-foreground">Haftalik ish jadvali</p>
            {hours === null ? (
              <LoadingRow />
            ) : hours.length === 0 ? (
              <p className="py-4 text-sm text-ink-muted">Jadval o‘rnatilmagan — admin panel sozlaydi.</p>
            ) : (
              <div className="space-y-1.5">
                {WEEKDAYS.map((dayName, idx) => {
                  const slot = hours.find((h) => h.weekday === idx + 1);
                  return (
                    <div key={idx + 1} className="flex items-center justify-between border-b border-hairline pb-1.5 text-sm">
                      <span className="text-ink-muted">{dayName}</span>
                      <span className="font-medium text-foreground">
                        {slot ? `${slot.start_time} — ${slot.end_time}` : "Ishlamaydi"}
                      </span>
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          <Card className="flex flex-col gap-3">
            <p className="text-sm font-bold text-foreground">Tanaffus / bo‘sh vaqt qo‘shish</p>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="mb-1 text-xs text-ink-muted">Boshlanishi</p>
                <AInput value={start} onChange={setStart} type="datetime-local" aria-label="Boshlanishi" />
              </div>
              <div>
                <p className="mb-1 text-xs text-ink-muted">Tugashi</p>
                <AInput value={end} onChange={setEnd} type="datetime-local" aria-label="Tugashi" />
              </div>
            </div>
            <div>
              <AButton onClick={() => void addBreak()}>Qo‘shish</AButton>
            </div>
            <div className="mt-2">
              {blocks === null ? (
                <LoadingRow />
              ) : blocks.length === 0 ? (
                <p className="py-2 text-sm text-ink-muted">Tanaffuslar yo‘q</p>
              ) : (
                <ATable headers={["Vaqt", "Sabab", ""]}>
                  {blocks.map((b) => (
                    <tr key={b.id}>
                      <td className="px-3 py-2 text-sm text-foreground">{formatDateTime(b.starts_at)} — {formatDateTime(b.ends_at)}</td>
                      <td className="px-3 py-2"><ABadge tone={b.reason === "absence" ? "amber" : "blue"}>{b.reason === "absence" ? "Ishda yo‘q" : "Tanaffus"}</ABadge></td>
                      <td className="px-3 py-2"><AButton size="sm" variant="ghost" onClick={() => void deleteBlock(b.id)}>O‘chirish</AButton></td>
                    </tr>
                  ))}
                </ATable>
              )}
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}