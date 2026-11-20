-- Separate transaction before using the new enum value.
alter type public.payment_status add value if not exists 'voided';
