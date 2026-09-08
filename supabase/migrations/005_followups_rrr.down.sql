-- down 005
select cron.unschedule('refresh-segments')
where exists (select 1 from cron.job where jobname = 'refresh-segments');
drop function if exists fn_refresh_segments();
drop trigger if exists trg_orders_rrr on orders;
drop function if exists fn_create_rrr_followups();
drop table if exists followups;
drop table if exists course_plans;
