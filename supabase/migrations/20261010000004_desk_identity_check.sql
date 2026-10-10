-- The passport in hand (owner request 2026-10-10: "the system should check whether the ID/passport details are true").
--
-- Online, only OneID can prove a typed passport is real and the typist's (20261010000003). Until the OneID agreement
-- is signed — and for every patient who never uses it — the card is confirmed at the desk on the first visit: the
-- receptionist types the series/number (or JSHSHIR) and the date of birth FROM THE DOCUMENT IN THEIR HAND, and
-- verify_identity_at_desk() compares them with the card. Staff never see the stored values; the answer is only
-- verified / mismatch. A card without a document yet gets the document from the desk.
--
--   * patients.identity_verified_by gains 'reception'; identity_verified_at records when.
--   * Every attempt is audited with ids and the outcome only; a mismatch never says which value differed.

alter table public.patients drop constraint patients_identity_verified_by_check;
alter table public.patients add constraint patients_identity_verified_by_check
  check (identity_verified_by in ('oneid', 'reception'));

create or replace function public.verify_identity_at_desk(
  p_clinic uuid, p_patient uuid, p_actor uuid, p_document text, p_pinfl text, p_dob date)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  c public.patients%rowtype;
  v_outcome text;
begin
  if (p_document is null) = (p_pinfl is null) or p_dob is null then
    raise exception using message = 'desk identity: one document and the date of birth', errcode = '22023', hint = 'invalid_identity';
  end if;
  if p_document is not null and p_document !~ '^[A-Z]{2}[0-9]{7}$' then
    raise exception using message = 'desk identity: bad document', errcode = '22023', hint = 'invalid_identity';
  end if;
  if p_pinfl is not null and p_pinfl !~ '^[0-9]{14}$' then
    raise exception using message = 'desk identity: bad pinfl', errcode = '22023', hint = 'invalid_identity';
  end if;
  -- Only clinic staff who work the desk (or management) act here.
  if not exists (
    select 1 from public.staff_roles
     where clinic_id = p_clinic and profile_id = p_actor and role in ('owner', 'admin', 'manager', 'receptionist')
  ) then
    raise exception using message = 'desk identity: not desk staff', errcode = '42501';
  end if;

  select * into c from public.patients where id = p_patient and clinic_id = p_clinic for update;
  if not found or c.merged_into_patient_id is not null then
    raise exception using message = 'desk identity: no card', errcode = '22023', hint = 'patient_not_found';
  end if;

  if c.date_of_birth is not null and c.date_of_birth <> p_dob then
    v_outcome := 'mismatch';
  elsif p_document is not null and c.document_number is not null then
    v_outcome := case when c.document_number = p_document then 'verified' else 'mismatch' end;
  elsif p_pinfl is not null and c.pinfl is not null then
    v_outcome := case when c.pinfl = p_pinfl then 'verified' else 'mismatch' end;
  elsif c.document_number is not null or c.pinfl is not null then
    -- The card holds the other kind of document: ask for that one (the passport also carries the JSHSHIR).
    v_outcome := 'other_document';
  elsif exists (
    select 1 from public.patients o
     where o.clinic_id = p_clinic and o.id <> c.id
       and ((p_document is not null and o.document_number = p_document) or (p_pinfl is not null and o.pinfl = p_pinfl))
  ) then
    -- No document on this card yet, but another card already has this one: reception merges them.
    v_outcome := 'document_in_use';
  else
    update public.patients
       set document_number = coalesce(p_document, document_number),
           pinfl = coalesce(p_pinfl, pinfl),
           date_of_birth = p_dob
     where id = c.id;
    v_outcome := 'verified';
  end if;

  if v_outcome = 'verified' then
    update public.patients set identity_verified_at = now(), identity_verified_by = 'reception' where id = c.id;
  end if;

  insert into public.audit_events (clinic_id, actor_id, actor_type, action, entity_type, entity_id, patient_id, metadata)
  values (p_clinic, p_actor, 'staff',
          case when v_outcome = 'verified' then 'patient_identity_verified' else 'patient_identity_check_failed' end,
          'patients', c.id::text, c.id, jsonb_build_object('method', 'reception', 'outcome', v_outcome));
  return v_outcome;
end;
$$;

revoke all on function public.verify_identity_at_desk(uuid, uuid, uuid, text, text, date) from public, anon, authenticated;
grant execute on function public.verify_identity_at_desk(uuid, uuid, uuid, text, text, date) to service_role;
