
ALTER TABLE public.people
  ADD COLUMN machine_key text,
  ADD COLUMN source_id text,
  ADD COLUMN matric_no text,
  ADD COLUMN staff_no text,
  ADD COLUMN programme text,
  ADD COLUMN last_name text,
  ADD COLUMN first_name text,
  ADD COLUMN middle_name text;

CREATE INDEX people_machine_key_idx ON public.people (machine_key);
CREATE INDEX people_type_machine_idx ON public.people (person_type, machine_key);

ALTER TABLE public.session_population ADD COLUMN machine_key text;
CREATE INDEX session_population_machine_idx ON public.session_population (machine_key);

REVOKE EXECUTE ON FUNCTION public.has_role(uuid, public.app_role) FROM anon;
REVOKE EXECUTE ON FUNCTION public.can_edit(uuid) FROM anon;
