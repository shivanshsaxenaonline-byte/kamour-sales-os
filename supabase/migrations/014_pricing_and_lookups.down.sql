-- down 014
alter table leads alter column sla_due_at drop default;
delete from concerns where code in
  ('ed','pme','low_libido','performance_anxiety','skin_irritation','sexologist','other');
delete from lead_sources where code in
  ('kapeefit','reactivation','calling','wati_elementor','justdial','facebook','instagram','flipkart','indiamart');
delete from payment_modes where code = 'prepaid';
delete from couriers where code in ('bluedart','dtdc','shadowfax','maruti','store');
delete from combo_items where combo_product_id = (select id from products where sku='CMB-B7');
update products set mrp = null, sale_price = null, default_course_days = null
where sku in ('GP30','GP60','DC30','DC60','PD','BUO','SGR','CMB-B7');
