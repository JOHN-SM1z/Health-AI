import { NextResponse, type NextRequest } from "next/server";
import { finishOneId } from "@/lib/identity/oneid";

export const dynamic = "force-dynamic";

/**
 * OneID returns the patient here (browser redirect) with a one-time code and our state. The code is exchanged
 * server-to-server; the page the patient sees says only how it ended — never their details.
 */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");
  const outcome = code && state && state.length <= 200 && code.length <= 2000 ? await finishOneId(code, state) : "failed";
  return NextResponse.redirect(new URL(`/oneid/result?r=${outcome}`, request.nextUrl.origin), { status: 303 });
}
