"use client";

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { UserRound } from "lucide-react";
import { PageHeader, Card, ABadge, ATable, AEmpty, AError, AButton, LoadingRow } from "@/components/admin/ui";
import { adminApi, AdminApiError, formatDateTime, STATUS_LABELS, STATUS_TONES } from "@/lib/admin/client";
import { ReferralDialog } from "@/components/doctor/referral-dialog";

type Appointment = {
  id: string;
  startAt: string;
  status: string;
  mine: boolean;
  doctor: { id: string; name: string } | null;
  service: { name: string } | null;
};

type PatientRecord = {
  patient: { id: string; fullName: string | null; phone: string | null };
  relationship: "own" | "referred";
  activeReferralIds: string[];
  appointments: Appointment[];
};

/** A doctor may refer from their own visit once the patient has been seen. */
const REFERABLE = ["in_progress", "completed"];

/**
 * A patient as the signed-in doctor may see them. The server decides what
 * that is (own patient, or one actively referred to this doctor) and answers
 * "not found" for anything else — this page only renders the answer.
 */
export default function DoctorPatientPage() {
  const { id } = useParams<{ id: string }>();
  const [record, setRecord] = useState<PatientRecord | null>(null);
  const [missing, setMissing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [referFrom, setReferFrom] = useState<Appointment | null>(null);
  const [sentReferralId, setSentReferralId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await adminApi.get<{ record: PatientRecord }>(`/api/doctor/patients/${id}`);
      setRecord(res.record);
      setMissing(false);
    } catch (e) {
      if (e instanceof AdminApiError && e.status === 404) setMissing(true);
      else setError(e instanceof AdminApiError ? e.message : "Bemor ma‘lumotlarini yuklab bo‘lmadi");
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const back = (
    <Link href="/doctor" className="text-sm font-medium text-pine hover:underline">
      ← Bugungi navbat
    </Link>
  );

  if (missing) {
    return (
      <div>
        <PageHeader title="Bemor" action={back} />
        <Card>
          <AEmpty
            title="Bemor topilmadi"
            subtitle="U mavjud emas yoki uni ko‘rishga ruxsatingiz yo‘q"
            icon={<UserRound className="h-6 w-6" />}
          />
        </Card>
      </div>
    );
  }

  if (!record) {
    return (
      <div>
        <PageHeader title="Bemor" action={back} />
        {error && <AError message={error} />}
        <Card>
          <LoadingRow />
        </Card>
      </div>
    );
  }

  return (
    <div>
      <PageHeader title={record.patient.fullName ?? "Bemor"} subtitle={record.patient.phone ?? undefined} action={back} />
      {error && <AError message={error} />}
      {sentReferralId && (
        <Card className="mb-4 border-pine/30 bg-pine-tint/60">
          <p className="text-sm font-medium text-pine-deep">
            Yo‘llanma yuborildi.{" "}
            <Link href={`/doctor/referrals/${sentReferralId}`} className="underline">
              Yo‘llanmani ko‘rish
            </Link>
          </p>
        </Card>
      )}

      <Card className="mb-4">
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {record.relationship === "own" ? (
            <ABadge tone="green">Mening bemorim</ABadge>
          ) : (
            <ABadge tone="blue">Yo‘llanma bo‘yicha</ABadge>
          )}
          <span className="text-ink-muted">
            {record.relationship === "own"
              ? "Sizning qabullaringiz ko‘rsatilgan."
              : "Yo‘llanma faol ekan, unga tegishli qabullar ko‘rsatiladi."}
          </span>
          {record.activeReferralIds.map((referralId) => (
            <Link key={referralId} href={`/doctor/referrals/${referralId}`} className="font-medium text-pine hover:underline">
              Yo‘llanmani ochish
            </Link>
          ))}
        </div>
      </Card>

      {record.appointments.length === 0 ? (
        <Card>
          <AEmpty title="Ko‘rsatiladigan qabul yo‘q" icon={<UserRound className="h-6 w-6" />} />
        </Card>
      ) : (
        <ATable headers={["Sana", "Shifokor", "Xizmat", "Holat", ""]}>
          {record.appointments.map((a) => (
            <tr key={a.id} className="hover:bg-sand">
              <td className="px-4 py-3 text-foreground">{formatDateTime(a.startAt)}</td>
              <td className="px-4 py-3 text-foreground">{a.mine ? "Siz" : (a.doctor?.name ?? "—")}</td>
              <td className="px-4 py-3 text-foreground">{a.service?.name ?? "—"}</td>
              <td className="px-4 py-3">
                <ABadge tone={STATUS_TONES[a.status] ?? "neutral"}>{STATUS_LABELS[a.status] ?? a.status}</ABadge>
              </td>
              <td className="px-4 py-3">
                {a.mine && REFERABLE.includes(a.status) && (
                  <AButton size="sm" variant="outline" onClick={() => setReferFrom(a)}>
                    Yo‘llanma
                  </AButton>
                )}
              </td>
            </tr>
          ))}
        </ATable>
      )}

      {referFrom && (
        <ReferralDialog
          consultation={{ appointmentId: referFrom.id, startAt: referFrom.startAt, serviceName: referFrom.service?.name ?? null }}
          patientName={record.patient.fullName ?? "—"}
          onClose={() => setReferFrom(null)}
          onCreated={(referralId) => {
            setReferFrom(null);
            setSentReferralId(referralId);
          }}
        />
      )}
    </div>
  );
}
