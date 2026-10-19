-- Additive only. Apply as the migration administrator, never the HTTP runtime.
DO $$ BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='kode_infra_owner') THEN CREATE ROLE kode_infra_owner NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='kode_infra_runtime') THEN CREATE ROLE kode_infra_runtime NOLOGIN; END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='kode_infra_provisioner') THEN CREATE ROLE kode_infra_provisioner NOLOGIN; END IF;
  IF EXISTS (SELECT FROM pg_roles WHERE rolname IN ('kode_infra_owner','kode_infra_runtime','kode_infra_provisioner')
    AND (rolcanlogin OR rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls)) THEN
    RAISE EXCEPTION 'Infrastructure privilege groups must be restricted NOLOGIN roles';
  END IF;
END $$;
CREATE SCHEMA infrastructure AUTHORIZATION kode_infra_owner;
SET LOCAL ROLE kode_infra_owner;
REVOKE ALL ON SCHEMA infrastructure FROM PUBLIC;
ALTER DEFAULT PRIVILEGES IN SCHEMA infrastructure REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
CREATE TABLE infrastructure.accounts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
 login text NOT NULL UNIQUE CHECK (login=lower(btrim(login))), display_name text NOT NULL,
 password_hash text, status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','active','disabled')),
 auth_version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE infrastructure.account_permissions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES infrastructure.accounts(id),
 permission text NOT NULL CHECK(permission IN ('infra.dashboard.read','infra.servers.read')),
 UNIQUE(account_id,permission)
);
CREATE TABLE infrastructure.bootstrap_tokens (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES infrastructure.accounts(id),
 token_hash text NOT NULL UNIQUE, expires_at timestamptz NOT NULL, consumed_at timestamptz
);
CREATE TABLE infrastructure.mfa_credentials (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL UNIQUE REFERENCES infrastructure.accounts(id),
 kind text NOT NULL DEFAULT 'totp' CHECK(kind='totp'), secret_box jsonb NOT NULL, last_counter bigint NOT NULL DEFAULT -1,
 confirmed_at timestamptz NOT NULL
);
CREATE TABLE infrastructure.recovery_codes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES infrastructure.accounts(id),
 code_hash text NOT NULL UNIQUE, used_at timestamptz
);
CREATE TABLE infrastructure.auth_challenges (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid REFERENCES infrastructure.accounts(id),
 token_hash text NOT NULL UNIQUE, purpose text NOT NULL CHECK(purpose IN ('browser','mfa','enroll','recovery')),
 auth_version integer, pending_password_hash text, pending_secret_box jsonb,
 expires_at timestamptz NOT NULL, consumed_at timestamptz
);
CREATE TABLE infrastructure.sessions (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid NOT NULL REFERENCES infrastructure.accounts(id),
 token_hash text NOT NULL UNIQUE, auth_version integer NOT NULL,
 created_at timestamptz NOT NULL, last_activity_at timestamptz NOT NULL, expires_at timestamptz NOT NULL,
 authenticated_at timestamptz NOT NULL, revoked_at timestamptz
);
CREATE INDEX infra_sessions_account_idx ON infrastructure.sessions(account_id);
CREATE TABLE infrastructure.authentication_attempts (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), rate_key text NOT NULL, attempted_at timestamptz NOT NULL,
 action text NOT NULL
);
CREATE INDEX infra_attempts_window_idx ON infrastructure.authentication_attempts(rate_key,attempted_at);
CREATE TABLE infrastructure.audit_events (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), account_id uuid REFERENCES infrastructure.accounts(id),
 action text NOT NULL CHECK(length(action)<=80), successful boolean NOT NULL, actor text NOT NULL CHECK(length(actor)<=128), request_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), reason text CHECK(length(reason)<=80),
 organization_id uuid, object_id uuid, database_actor text,
 previous_permissions text[], new_permissions text[], added_permissions text[], removed_permissions text[]
);
CREATE INDEX infra_audit_account_time_idx ON infrastructure.audit_events(account_id,created_at);
CREATE TABLE infrastructure.servers (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), organization_id uuid NOT NULL,
 label text NOT NULL, display_address text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
REVOKE ALL ON ALL TABLES IN SCHEMA infrastructure FROM PUBLIC;
GRANT USAGE ON SCHEMA infrastructure TO kode_infra_runtime,kode_infra_provisioner;
GRANT SELECT ON infrastructure.accounts,infrastructure.account_permissions,infrastructure.servers TO kode_infra_runtime;
GRANT UPDATE(password_hash,status,auth_version) ON infrastructure.accounts TO kode_infra_runtime;
GRANT SELECT,INSERT,UPDATE,DELETE ON infrastructure.auth_challenges,infrastructure.mfa_credentials,
 infrastructure.recovery_codes,infrastructure.sessions TO kode_infra_runtime;
GRANT SELECT,UPDATE ON infrastructure.bootstrap_tokens TO kode_infra_runtime;
GRANT SELECT,INSERT ON infrastructure.authentication_attempts TO kode_infra_runtime;
GRANT INSERT ON infrastructure.audit_events TO kode_infra_runtime;
-- Provisioner has EXECUTE only: never table access to passwords, MFA or sessions.
CREATE FUNCTION infrastructure.validate_operator(p_actor text, p_request uuid) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF p_actor IS NULL OR p_actor !~ '^operator:.{1,100}$' OR p_request IS NULL THEN
   RAISE EXCEPTION 'Invalid operator attribution';
 END IF;
END $$;
CREATE FUNCTION infrastructure.validate_permissions(p_permissions text[]) RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 IF p_permissions IS NULL OR cardinality(p_permissions) NOT BETWEEN 1 AND 2
 OR array_position(p_permissions,NULL) IS NOT NULL
 OR NOT p_permissions <@ ARRAY['infra.dashboard.read','infra.servers.read']::text[] THEN
   RAISE EXCEPTION 'Invalid permissions';
 END IF;
END $$;
CREATE FUNCTION infrastructure.provision_account(p_org uuid,p_login text,p_name text,
 p_permissions text[],p_bootstrap text,p_actor text,p_request uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_id uuid;
BEGIN
 PERFORM infrastructure.validate_operator(p_actor,p_request);
 PERFORM infrastructure.validate_permissions(p_permissions);
 IF p_org IS NULL OR p_login IS NULL OR length(p_login) NOT BETWEEN 1 AND 254
 OR p_login<>lower(btrim(p_login)) OR p_name IS NULL OR length(btrim(p_name)) NOT BETWEEN 1 AND 100
 OR p_bootstrap IS NULL OR p_bootstrap !~ '^[a-f0-9]{64}$' THEN RAISE EXCEPTION 'Invalid account'; END IF;
 INSERT INTO infrastructure.accounts(organization_id,login,display_name)
 VALUES(p_org,p_login,p_name) RETURNING id INTO v_id;
 INSERT INTO infrastructure.account_permissions(account_id,permission)
 SELECT v_id, p FROM (SELECT DISTINCT unnest(p_permissions) p) grants;
 INSERT INTO infrastructure.bootstrap_tokens(account_id,token_hash,expires_at)
 VALUES(v_id,p_bootstrap,clock_timestamp()+interval '15 minutes');
 INSERT INTO infrastructure.audit_events(account_id,organization_id,object_id,action,successful,actor,database_actor,request_id,reason,new_permissions)
 VALUES(v_id,p_org,v_id,'account.provisioned',true,p_actor,session_user,p_request,'operator_requested',p_permissions);
 RETURN v_id;
END $$;
CREATE FUNCTION infrastructure.manage_account(p_org uuid,p_login text,p_action text,
 p_permissions text[],p_bootstrap text,p_actor text,p_request uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_id uuid; v_old text[]; v_new text[]; v_now timestamptz := clock_timestamp();
BEGIN
 PERFORM infrastructure.validate_operator(p_actor,p_request);
 IF p_action IS NULL OR p_action NOT IN ('disable','revoke','reset','permissions') OR p_org IS NULL THEN
 RAISE EXCEPTION 'Invalid account operation'; END IF;
 IF p_action='permissions' THEN PERFORM infrastructure.validate_permissions(p_permissions); END IF;
 IF p_action='reset' AND (p_bootstrap IS NULL OR p_bootstrap !~ '^[a-f0-9]{64}$') THEN
 RAISE EXCEPTION 'Invalid bootstrap'; END IF;
 SELECT id INTO STRICT v_id FROM infrastructure.accounts WHERE organization_id=p_org AND login=p_login FOR UPDATE;
 SELECT coalesce(array_agg(permission ORDER BY permission),ARRAY[]::text[]) INTO v_old
 FROM infrastructure.account_permissions WHERE account_id=v_id;
 UPDATE infrastructure.accounts SET auth_version=auth_version+1,
 status=CASE p_action WHEN 'disable' THEN 'disabled' WHEN 'reset' THEN 'pending' ELSE status END,
 password_hash=CASE WHEN p_action='reset' THEN NULL ELSE password_hash END WHERE id=v_id;
 UPDATE infrastructure.sessions SET revoked_at=coalesce(revoked_at,v_now) WHERE account_id=v_id;
 UPDATE infrastructure.auth_challenges SET consumed_at=coalesce(consumed_at,v_now),pending_password_hash=NULL,pending_secret_box=NULL WHERE account_id=v_id;
 UPDATE infrastructure.bootstrap_tokens SET consumed_at=coalesce(consumed_at,v_now) WHERE account_id=v_id;
 IF p_action='reset' THEN
 DELETE FROM infrastructure.mfa_credentials WHERE account_id=v_id;
 DELETE FROM infrastructure.recovery_codes WHERE account_id=v_id;
 INSERT INTO infrastructure.bootstrap_tokens(account_id,token_hash,expires_at) VALUES(v_id,p_bootstrap,v_now+interval '15 minutes');
 END IF;
 IF p_action='permissions' THEN
 DELETE FROM infrastructure.account_permissions WHERE account_id=v_id;
 INSERT INTO infrastructure.account_permissions(account_id,permission) SELECT v_id,p FROM (SELECT DISTINCT unnest(p_permissions) p) grants;
 END IF;
 SELECT coalesce(array_agg(permission ORDER BY permission),ARRAY[]::text[]) INTO v_new
 FROM infrastructure.account_permissions WHERE account_id=v_id;
 INSERT INTO infrastructure.audit_events(account_id,organization_id,object_id,action,successful,actor,database_actor,request_id,reason,
 previous_permissions,new_permissions,added_permissions,removed_permissions)
 VALUES(v_id,p_org,v_id,'account.'||p_action,true,p_actor,session_user,p_request,'operator_requested',v_old,v_new,
 ARRAY(SELECT unnest(v_new) EXCEPT SELECT unnest(v_old)),ARRAY(SELECT unnest(v_old) EXCEPT SELECT unnest(v_new)));
END $$;
CREATE FUNCTION infrastructure.register_server(p_org uuid,p_label text,p_address text,p_actor text,p_request uuid) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_id uuid;
BEGIN
 PERFORM infrastructure.validate_operator(p_actor,p_request);
 IF p_org IS NULL OR p_label IS NULL OR length(btrim(p_label)) NOT BETWEEN 1 AND 100
 OR p_address IS NULL OR length(p_address) NOT BETWEEN 1 AND 254 OR p_address ~ '[\r\n]' THEN
 RAISE EXCEPTION 'Invalid display metadata'; END IF;
 INSERT INTO infrastructure.servers(organization_id,label,display_address) VALUES(p_org,p_label,p_address) RETURNING id INTO v_id;
 INSERT INTO infrastructure.audit_events(organization_id,object_id,action,successful,actor,database_actor,request_id,reason)
 VALUES(p_org,v_id,'server.registered',true,p_actor,session_user,p_request,'operator_requested');
 RETURN v_id;
END $$;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA infrastructure FROM PUBLIC;
GRANT EXECUTE ON FUNCTION infrastructure.provision_account(uuid,text,text,text[],text,text,uuid),
 infrastructure.manage_account(uuid,text,text,text[],text,text,uuid),
 infrastructure.register_server(uuid,text,text,text,uuid) TO kode_infra_provisioner;
-- The CLI records rejected operations after the failed transaction has rolled back.
CREATE FUNCTION infrastructure.record_operator_denial(p_org uuid,p_login text,p_action text,p_actor text,p_request uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_id uuid;
BEGIN
 PERFORM infrastructure.validate_operator(p_actor,p_request);
 IF p_org IS NULL OR p_action IS NULL OR p_action NOT IN ('provisioned','disable','revoke','reset','permissions','server.registered')
 OR length(p_login)>254 THEN RAISE EXCEPTION 'Invalid operator event'; END IF;
 SELECT id INTO v_id FROM infrastructure.accounts WHERE organization_id=p_org AND login=p_login;
 INSERT INTO infrastructure.audit_events(account_id,organization_id,object_id,action,successful,actor,database_actor,request_id,reason)
 VALUES(v_id,p_org,v_id,CASE WHEN p_action='server.registered' THEN p_action ELSE 'account.'||p_action END,
 false,p_actor,session_user,p_request,'operation_rejected');
END $$;
REVOKE ALL ON FUNCTION infrastructure.record_operator_denial(uuid,text,text,text,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION infrastructure.record_operator_denial(uuid,text,text,text,uuid) TO kode_infra_provisioner;
-- Denials are aggregates, separate from immutable critical-transition events.
CREATE TABLE infrastructure.denial_windows (
 window_start timestamptz NOT NULL, reason text NOT NULL, actor text NOT NULL,
 account_id uuid, first_request_id uuid NOT NULL, last_request_id uuid NOT NULL,
 first_at timestamptz NOT NULL, last_at timestamptz NOT NULL, occurrences bigint NOT NULL,
 PRIMARY KEY(window_start,reason,actor)
);
CREATE FUNCTION infrastructure.record_denial(p_reason text,p_actor text,p_account uuid,p_request uuid) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE v_now timestamptz := clock_timestamp(); v_window timestamptz;
 v_actor text; v_account uuid; v_count integer;
BEGIN
 IF p_reason IS NULL OR p_reason NOT IN ('throttled','forbidden','invalid_authentication','service_unavailable','ingress_limited')
 OR p_actor IS NULL OR length(p_actor)>100 OR p_actor NOT LIKE 'http:%' OR p_request IS NULL THEN
 RAISE EXCEPTION 'Invalid denial metadata'; END IF;
 v_window := date_trunc('minute',v_now);
 PERFORM pg_advisory_xact_lock(hashtextextended('infrastructure.denial:'||v_window::text,0));
 -- Account is already validated by HTTP code; include it in the bounded aggregate identity.
 v_actor := p_actor || ':' || coalesce(p_account::text,'unknown'); v_account := p_account;
 IF NOT EXISTS(SELECT FROM infrastructure.denial_windows WHERE window_start=v_window AND reason=p_reason AND actor=v_actor) THEN
 SELECT count(*) INTO v_count FROM infrastructure.denial_windows WHERE window_start=v_window AND actor<>'overflow';
 IF v_count>=100 THEN v_actor:='overflow'; v_account:=NULL; END IF;
 END IF;
 INSERT INTO infrastructure.denial_windows(window_start,reason,actor,account_id,first_request_id,last_request_id,first_at,last_at,occurrences)
 VALUES(v_window,p_reason,v_actor,v_account,p_request,p_request,v_now,v_now,1)
 ON CONFLICT(window_start,reason,actor) DO UPDATE SET
 last_request_id=excluded.last_request_id,last_at=excluded.last_at,occurrences=infrastructure.denial_windows.occurrences+1;
END $$;
REVOKE ALL ON infrastructure.denial_windows FROM PUBLIC;
REVOKE ALL ON FUNCTION infrastructure.record_denial(text,text,uuid,uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION infrastructure.record_denial(text,text,uuid,uuid) TO kode_infra_runtime;
-- Owner-only retention. Neither runtime nor provisioner may erase audit history.
CREATE FUNCTION infrastructure.retain_history() RETURNS void
LANGUAGE plpgsql SET search_path=pg_catalog AS $$ BEGIN
 DELETE FROM infrastructure.authentication_attempts WHERE attempted_at<clock_timestamp()-interval '1 day';
 DELETE FROM infrastructure.denial_windows WHERE window_start<clock_timestamp()-interval '90 days';
 DELETE FROM infrastructure.audit_events WHERE created_at<clock_timestamp()-interval '365 days';
 DELETE FROM infrastructure.auth_challenges WHERE expires_at<clock_timestamp()-interval '1 day';
END $$;
REVOKE ALL ON FUNCTION infrastructure.retain_history() FROM PUBLIC;
RESET ROLE;
