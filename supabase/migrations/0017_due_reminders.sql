-- ============================================================================
-- 0017_due_reminders.sql
-- Web-Push daily reminders. claim_due_reminders() atomically finds users whose
-- local time == their daily_reminder_time (and who have a web push token), marks
-- them sent (last_reminder_at) so they can't be double-notified, and returns their
-- push subscriptions for the send-reminders Edge Function (called every minute by
-- pg_cron). SECURITY DEFINER + service_role only.
-- ============================================================================
create or replace function public.claim_due_reminders()
returns table (user_id uuid, tokens text[])
language plpgsql
security definer
set search_path = public
as $$
begin
  return query
  with due as (
    select distinct us.user_id
    from user_settings us
    join device_tokens dt on dt.user_id = us.user_id and dt.platform = 'web'
    where us.notifications_enabled
      and us.daily_reminder_time is not null
      and to_char((now() at time zone coalesce(us.timezone, 'UTC')), 'HH24:MI')
          = to_char(us.daily_reminder_time, 'HH24:MI')
      and (us.last_reminder_at is null or us.last_reminder_at < now() - interval '23 hours')
  ),
  claimed as (
    update user_settings us
       set last_reminder_at = now()
      from due
     where us.user_id = due.user_id
    returning us.user_id
  )
  select c.user_id, array_agg(dt.token)
  from claimed c
  join device_tokens dt on dt.user_id = c.user_id and dt.platform = 'web'
  group by c.user_id;
end;
$$;

revoke all on function public.claim_due_reminders() from public;
grant execute on function public.claim_due_reminders() to service_role;
