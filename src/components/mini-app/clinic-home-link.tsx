"use client";
import Link from "next/link";
import {useSearchParams} from "next/navigation";
import {ChevronLeft} from "lucide-react";
export function ClinicHomeLink(){const clinic=useSearchParams().get("clinic");return <Link href={clinic?`/?clinic=${encodeURIComponent(clinic)}`:"/"} aria-label="Bosh sahifa" className="flex h-9 w-9 items-center justify-center rounded-full border border-hairline"><ChevronLeft className="h-5 w-5"/></Link>;}
