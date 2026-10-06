-- 0034: Referral lifecycle hardening.
--
-- Guarantees:
--   1. No open-ended/permanent referrals: if expires_at is omitted on INSERT,
--      it is automatically defaulted based on priority:
--        emergency: now() + 2 days
--        urgent:    now() + 7 days
--        routine:   now() + 30 days
--   2. Check constraint: expires_at must be strictly after created_at.
--   3. Trigger validation for revocation and expiration transitions:
--      - pending     → accepted | declined | revoked | expired
--      - accepted    → in_progress | completed | revoked | expired
--      - in_progress → completed | revoked | expired
--      - terminal states (completed, declined, revoked, expired) are immutable.
--   4. Revocation tracking: revoked_at is automatically populated on transition to revoked.

-- ---------- 1. Default expiration trigger ----------

create or replace function public.referrals_apply_default_expiration()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.expires_at is null then
    case new.priority
      when 'emergency'::public.referral_priority then
        new.expires_at := new.created_at + interval '2 days';
      when 'urgent'::public.referral_priority then
        new.expires_at := new.created_at + interval '7 days';
      else
        new.expires_at := new.created_at + interval '30 days';
    end case;
  end if;

  return new;
end;
$$;

drop trigger if exists referrals_apply_default_expiration_trigger on public.referrals;

create trigger referrals_apply_default_expiration_trigger
  before insert on public.referrals
  for each row
  execute function public.referrals_apply_default_expiration();

-- ---------- 2. Check constraint: expires_at > created_at ----------

alter table public.referrals
  drop constraint if exists referrals_expires_at_check;

alter table public.referrals
  add constraint referrals_expires_at_check
    check (expires_at is null or expires_at > created_at);

-- ---------- 3. Updated status transition trigger with revocation checks ----------

create or replace function public.referrals_validate_status_transition()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'INSERT' then
    if new.status <> 'pending'::public.referral_status then
      raise exception 'referrals: new referrals must be created with status pending, got %', new.status;
    end if;
    return new;
  end if;

  -- On UPDATE: no-op if status unchanged
  if old.status = new.status then
    return new;
  end if;

  case old.status
    when 'pending'::public.referral_status then
      if new.status = 'accepted'::public.referral_status then
        if new.accepted_at is null then
          new.accepted_at := now();
        end if;
      elsif new.status = 'declined'::public.referral_status then
        null;
      elsif new.status = 'revoked'::public.referral_status then
        if new.revoked_at is null then
          new.revoked_at := now();
        end if;
      elsif new.status = 'expired'::public.referral_status then
        null;
      else
        raise exception 'referrals: invalid transition from pending to %', new.status;
      end if;

    when 'accepted'::public.referral_status then
      if new.status = 'in_progress'::public.referral_status then
        null;
      elsif new.status = 'completed'::public.referral_status then
        if new.completed_at is null then
          new.completed_at := now();
        end if;
      elsif new.status = 'revoked'::public.referral_status then
        if new.revoked_at is null then
          new.revoked_at := now();
        end if;
      elsif new.status = 'expired'::public.referral_status then
        null;
      else
        raise exception 'referrals: invalid transition from accepted to %', new.status;
      end if;

    when 'in_progress'::public.referral_status then
      if new.status = 'completed'::public.referral_status then
        if new.completed_at is null then
          new.completed_at := now();
        end if;
      elsif new.status = 'revoked'::public.referral_status then
        if new.revoked_at is null then
          new.revoked_at := now();
        end if;
      elsif new.status = 'expired'::public.referral_status then
        null;
      else
        raise exception 'referrals: invalid transition from in_progress to %', new.status;
      end if;

    when 'completed'::public.referral_status then
      raise exception 'referrals: cannot transition from terminal status completed';

    when 'declined'::public.referral_status then
      raise exception 'referrals: cannot transition from terminal status declined';

    when 'revoked'::public.referral_status then
      raise exception 'referrals: cannot transition from terminal status revoked';

    when 'expired'::public.referral_status then
      raise exception 'referrals: cannot transition from terminal status expired';

    else
      raise exception 'referrals: unrecognized status %', old.status;
  end case;

  return new;
end;
$$;
