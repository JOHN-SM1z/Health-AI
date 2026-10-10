import { describe, expect, it } from "vitest";
import { staleAppointmentMessage } from "./staleness";

const now = new Date("2026-10-10T07:00:00Z");
const ago = (minutes: number) => new Date(now.getTime() - minutes * 60000).toISOString();
const ahead = (minutes: number) => new Date(now.getTime() + minutes * 60000).toISOString();

describe("staleAppointmentMessage", () => {
  it("sends a reminder that is due now for an appointment still ahead", () => {
    expect(staleAppointmentMessage("reminder_24h", ago(10), ahead(24 * 60 - 10), now)).toBeNull();
    expect(staleAppointmentMessage("reminder_2h", ago(14), ahead(106), now)).toBeNull();
  });

  it("never sends any appointment message once the appointment time has passed", () => {
    for (const type of ["booking_confirmation", "reminder_24h", "reminder_2h", "cancellation", "reschedule"] as const) {
      expect(staleAppointmentMessage(type, ago(5), ago(1), now)).toBe("appointment time has passed");
    }
  });

  it("skips a reminder sent more than an hour late (its 'in 24/2 hours' wording would be wrong)", () => {
    expect(staleAppointmentMessage("reminder_2h", ago(61), ahead(59), now)).toBe("too late to send");
    expect(staleAppointmentMessage("reminder_24h", ago(3 * 60), ahead(21 * 60), now)).toBe("too late to send");
  });

  it("skips a confirmation, cancellation or reschedule notice older than a day", () => {
    expect(staleAppointmentMessage("booking_confirmation", ago(23 * 60), ahead(10 * 24 * 60), now)).toBeNull();
    expect(staleAppointmentMessage("booking_confirmation", ago(25 * 60), ahead(10 * 24 * 60), now)).toBe("too late to send");
    expect(staleAppointmentMessage("cancellation", ago(3 * 24 * 60), ahead(9 * 24 * 60), now)).toBe("too late to send");
  });

  it("leaves messages that are not about an appointment alone", () => {
    expect(staleAppointmentMessage("queue_ticket", ago(3 * 24 * 60), ago(60), now)).toBeNull();
    expect(staleAppointmentMessage("lab_result_ready", ago(3 * 24 * 60), ago(60), now)).toBeNull();
  });
});
