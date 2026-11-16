create extension if not exists pg_cron with schema pg_catalog;
select cron.schedule('without-permission-analytics-cleanup', '37 2 * * *', 'select public.wp_cleanup()');
