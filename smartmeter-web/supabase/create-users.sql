-- Creates the first accounts directly in Supabase Auth (run after schema.sql).
-- Replace the three passwords before running. Change them again after the first sign-in.
--   Robin      user
--   Abhigyan   user
--   Garv Jain  admin

create extension if not exists pgcrypto;

do $$
declare
  acc record;
  uid uuid;
begin
  for acc in
    select * from (values
      ('Robin',     'robin@wattwise.app',    'REPLACE_ROBIN_PASSWORD',    'user'),
      ('Abhigyan',  'abhigyan@wattwise.app', 'REPLACE_ABHIGYAN_PASSWORD', 'user'),
      ('Garv Jain', 'garv@wattwise.app',     'REPLACE_GARV_PASSWORD',     'admin')
    ) as t(full_name, email, pass, role)
  loop
    select id into uid from auth.users where email = acc.email;
    if uid is null then
      uid := gen_random_uuid();
      insert into auth.users (instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
                              raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
                              confirmation_token, email_change, email_change_token_new, recovery_token)
      values ('00000000-0000-0000-0000-000000000000', uid, 'authenticated', 'authenticated', acc.email,
              crypt(acc.pass, gen_salt('bf')), now(),
              '{"provider":"email","providers":["email"]}', jsonb_build_object('full_name', acc.full_name),
              now(), now(), '', '', '', '');
      insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
      values (gen_random_uuid(), uid, uid::text,
              jsonb_build_object('sub', uid::text, 'email', acc.email, 'email_verified', true),
              'email', now(), now(), now());
    end if;
    insert into public.profiles (id, full_name, email, role)
    values (uid, acc.full_name, acc.email, acc.role)
    on conflict (id) do update set full_name = excluded.full_name, email = excluded.email, role = excluded.role;
  end loop;
end $$;

select p.full_name, p.email, p.role from public.profiles p order by p.role desc, p.full_name;
