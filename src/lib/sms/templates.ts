/**
 * SMS texts (Slice D). Plain Latin with ASCII apostrophes (GSM-7, one segment where possible). Only the clinic's name,
 * the queue number and a one-time code — never a doctor, a service, a diagnosis or any other medical detail: an SMS
 * can be read by anyone holding the phone. Eskiz requires each template to be approved before production use.
 */
const clean = (s: string) =>
  s
    .normalize("NFKD")
    .replace(/[‘’ʻʼ`]/g, "'")
    .replace(/[^\x20-\x7E]/g, "")
    .trim()
    .slice(0, 40);

export function queueTicketSms(clinicName: string, queueNumber: number): string {
  return `${clean(clinicName)}: navbat raqamingiz ${queueNumber}. Navbatingiz kelganda SMS keladi.`;
}

export function queueCalledSms(clinicName: string, queueNumber: number): string {
  return `${clean(clinicName)}: ${queueNumber}-raqam, navbatingiz keldi. Qabulga kiring.`;
}

export function cardLinkCodeSms(clinicName: string, code: string): string {
  return `${clean(clinicName)}: kartani ulash kodi ${code}. Kodni hech kimga aytmang.`;
}
