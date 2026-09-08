-- down 002
drop table if exists customer_identities;
drop table if exists customers;
do $$
declare t text;
begin
  foreach t in array array[
    'lead_sources','lead_statuses','concerns','couriers',
    'payment_modes','lost_reasons','cancel_reasons'
  ] loop
    execute format('drop table if exists %I', t);
  end loop;
end $$;
drop table if exists users;
