"use client";
import ReceptionPage from "@/app/admin/reception/page";
import { DoctorLiveQueue } from "./doctor-live-queue";
/** Legacy import name, current server-authorized arrival/queue contracts. */
export function LiveQueue({ doctor = false }: { doctor?: boolean }) {
  return doctor ? <DoctorLiveQueue /> : <ReceptionPage />;
}
