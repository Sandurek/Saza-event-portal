-- 006_rls_and_functions.sql
-- Защитни функции, Row Level Security (RLS) и транзакционни процедури

-- Активиране на RLS за всички таблици
ALTER TABLE organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE organization_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE events ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE invitations ENABLE ROW LEVEL SECURITY;
ALTER TABLE event_templates ENABLE ROW LEVEL SECURITY;
ALTER TABLE template_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE milestones ENABLE ROW LEVEL SECURITY;
ALTER TABLE milestone_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE task_dependencies ENABLE ROW LEVEL SECURITY;
ALTER TABLE published_updates ENABLE ROW LEVEL SECURITY;
ALTER TABLE change_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE proposal_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE proposal_options ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_responses ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE budget_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE internal_costs ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE document_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE proposal_attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE comments ENABLE ROW LEVEL SECURITY;
ALTER TABLE comment_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE notifications ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE notification_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE idempotency_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE job_runs ENABLE ROW LEVEL SECURITY;

-- 1. Помощна функция: екипен член на организация
CREATE OR REPLACE FUNCTION is_active_org_staff(p_org_id UUID, p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1 FROM organization_memberships
        WHERE org_id = p_org_id
          AND user_id = p_user_id
          AND status = 'active'
    );
$$;

-- 2. Помощна функция: управление на събитие (owner/manager на организацията или назначен координатор)
CREATE OR REPLACE FUNCTION can_manage_event(p_event_id UUID, p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1 
        FROM events e
        JOIN organization_memberships om ON om.org_id = e.org_id AND om.user_id = p_user_id
        WHERE e.id = p_event_id
          AND om.status = 'active'
          AND (
              om.role IN ('owner', 'manager')
              OR (om.role = 'coordinator' AND e.primary_coordinator_id = p_user_id)
              OR EXISTS (
                  SELECT 1 FROM event_memberships em 
                  WHERE em.event_id = p_event_id 
                    AND em.user_id = p_user_id 
                    AND em.member_type = 'staff'
                    AND em.status = 'active'
              )
          )
    );
$$;

-- 3. Помощна функция: право за четене на събитие (екип или активен клиент на събитието)
CREATE OR REPLACE FUNCTION can_read_event(p_event_id UUID, p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1 
        FROM events e
        LEFT JOIN organization_memberships om ON om.org_id = e.org_id AND om.user_id = p_user_id AND om.status = 'active'
        LEFT JOIN event_memberships em ON em.event_id = e.id AND em.user_id = p_user_id AND em.status = 'active'
        WHERE e.id = p_event_id
          AND (
              om.role IN ('owner', 'manager')
              OR (om.role = 'coordinator' AND em.member_type = 'staff')
              OR (em.member_type = 'client' AND (em.access_expires_at IS NULL OR em.access_expires_at > NOW()))
          )
    );
$$;

-- 4. Помощна функция: право за преглед на бюджет
CREATE OR REPLACE FUNCTION can_read_budget(p_event_id UUID, p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1 
        FROM events e
        LEFT JOIN organization_memberships om ON om.org_id = e.org_id AND om.user_id = p_user_id AND om.status = 'active'
        LEFT JOIN event_memberships em ON em.event_id = e.id AND em.user_id = p_user_id AND em.status = 'active'
        WHERE e.id = p_event_id
          AND (
              om.role IN ('owner', 'manager', 'coordinator')
              OR (em.member_type = 'client' AND em.can_view_budget = TRUE AND (em.access_expires_at IS NULL OR em.access_expires_at > NOW()))
          )
    );
$$;

-- 5. Помощна функция: право за отговор по искане
CREATE OR REPLACE FUNCTION can_respond_to_request(p_request_id UUID, p_user_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
    SELECT EXISTS (
        SELECT 1 
        FROM approval_requests ar
        JOIN event_memberships em ON em.event_id = ar.event_id AND em.user_id = p_user_id
        WHERE ar.id = p_request_id
          AND ar.assignee_user_id = p_user_id
          AND ar.status = 'pending'
          AND ar.expires_at > NOW()
          AND em.status = 'active'
          AND em.client_role = 'client_decision_maker'
          AND (em.access_expires_at IS NULL OR em.access_expires_at > NOW())
    );
$$;

-- RLS Политики

-- Events
CREATE POLICY p_events_read ON events FOR SELECT USING (can_read_event(id, auth.uid()));
CREATE POLICY p_events_staff_write ON events FOR ALL USING (can_manage_event(id, auth.uid()));

-- Milestones (клиент вижда само публикувани!)
CREATE POLICY p_milestones_read ON milestones FOR SELECT USING (
    can_manage_event(event_id, auth.uid()) 
    OR (can_read_event(event_id, auth.uid()) AND published_at IS NOT NULL)
);
CREATE POLICY p_milestones_write ON milestones FOR ALL USING (can_manage_event(event_id, auth.uid()));

-- Milestone Drafts (само за екипа)
CREATE POLICY p_drafts_staff ON milestone_drafts FOR ALL USING (can_manage_event(event_id, auth.uid()));

-- Tasks (вътрешни задачи - строго за екипа)
CREATE POLICY p_tasks_staff ON tasks FOR ALL USING (can_manage_event(event_id, auth.uid()));
CREATE POLICY p_task_deps_staff ON task_dependencies FOR ALL USING (can_manage_event(event_id, auth.uid()));

-- Internal Costs (строго за екипа)
CREATE POLICY p_internal_costs_staff ON internal_costs FOR ALL USING (can_manage_event(event_id, auth.uid()));

-- Published Updates
CREATE POLICY p_published_updates_read ON published_updates FOR SELECT USING (
    can_manage_event(event_id, auth.uid()) 
    OR (can_read_event(event_id, auth.uid()) AND (requires_budget_permission = FALSE OR can_read_budget(event_id, auth.uid())))
);
CREATE POLICY p_published_updates_write ON published_updates FOR ALL USING (can_manage_event(event_id, auth.uid()));

-- Proposals & Versions
CREATE POLICY p_proposals_read ON proposals FOR SELECT USING (can_read_event(event_id, auth.uid()));
CREATE POLICY p_proposals_write ON proposals FOR ALL USING (can_manage_event(event_id, auth.uid()));

CREATE POLICY p_prop_versions_read ON proposal_versions FOR SELECT USING (
    can_manage_event(event_id, auth.uid())
    OR (can_read_event(event_id, auth.uid()) AND state <> 'draft' AND (requires_budget_permission = FALSE OR can_read_budget(event_id, auth.uid())))
);
CREATE POLICY p_prop_versions_write ON proposal_versions FOR ALL USING (can_manage_event(event_id, auth.uid()));

-- Approval Requests
CREATE POLICY p_app_req_read ON approval_requests FOR SELECT USING (
    can_manage_event(event_id, auth.uid())
    OR (can_read_event(event_id, auth.uid()) AND assignee_user_id = auth.uid())
);
CREATE POLICY p_app_req_write ON approval_requests FOR ALL USING (can_manage_event(event_id, auth.uid()));

-- Approval Responses
CREATE POLICY p_app_resp_read ON approval_responses FOR SELECT USING (
    can_manage_event(event_id, auth.uid()) OR actor_user_id = auth.uid()
);

-- Budgets
CREATE POLICY p_budget_read ON budget_versions FOR SELECT USING (can_read_budget(event_id, auth.uid()));
CREATE POLICY p_budget_write ON budget_versions FOR ALL USING (can_manage_event(event_id, auth.uid()));

CREATE POLICY p_budget_items_read ON budget_items FOR SELECT USING (can_read_budget(event_id, auth.uid()));
CREATE POLICY p_budget_items_write ON budget_items FOR ALL USING (can_manage_event(event_id, auth.uid()));

-- Payments
CREATE POLICY p_payment_sched_read ON payment_schedules FOR SELECT USING (can_read_budget(event_id, auth.uid()));
CREATE POLICY p_payment_sched_write ON payment_schedules FOR ALL USING (can_manage_event(event_id, auth.uid()));

CREATE POLICY p_payment_entries_read ON payment_entries FOR SELECT USING (can_read_budget(event_id, auth.uid()));
CREATE POLICY p_payment_entries_write ON payment_entries FOR ALL USING (can_manage_event(event_id, auth.uid()));

-- Documents
CREATE POLICY p_documents_read ON documents FOR SELECT USING (
    deleted_at IS NULL AND (
        can_manage_event(event_id, auth.uid())
        OR (audience = 'client' AND can_read_event(event_id, auth.uid()) AND (requires_budget_permission = FALSE OR can_read_budget(event_id, auth.uid())))
    )
);
CREATE POLICY p_documents_write ON documents FOR ALL USING (can_manage_event(event_id, auth.uid()));

-- Document Versions
CREATE POLICY p_doc_ver_read ON document_versions FOR SELECT USING (
    scan_state = 'ready' AND (
        can_manage_event(event_id, auth.uid())
        OR EXISTS (
            SELECT 1 FROM documents d 
            WHERE d.id = document_id 
              AND d.deleted_at IS NULL 
              AND d.audience = 'client' 
              AND can_read_event(event_id, auth.uid())
              AND (d.requires_budget_permission = FALSE OR can_read_budget(event_id, auth.uid()))
        )
    )
);
CREATE POLICY p_doc_ver_write ON document_versions FOR ALL USING (can_manage_event(event_id, auth.uid()));

-- Notifications
CREATE POLICY p_notifications_self ON notifications FOR ALL USING (recipient_id = auth.uid());

-- Audit log (само четене от служители на организацията)
CREATE POLICY p_audit_log_read ON audit_log FOR SELECT USING (is_active_org_staff(org_id, auth.uid()));

-- Транзакционна SQL процедура за клиентско решение (Section 9.3)
CREATE OR REPLACE FUNCTION process_approval_decision(
    p_request_id UUID,
    p_actor_id UUID,
    p_decision TEXT,
    p_selected_option_id UUID,
    p_comment TEXT,
    p_idempotency_key TEXT,
    p_request_hash TEXT
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    v_req RECORD;
    v_prop_ver RECORD;
    v_idem RECORD;
    v_resp_id UUID;
    v_res JSONB;
BEGIN
    -- 1. Проверка на идемпотентност
    SELECT * INTO v_idem FROM idempotency_keys
    WHERE actor_id = p_actor_id AND operation = 'approval_response' AND key = p_idempotency_key
    FOR UPDATE;

    IF FOUND THEN
        IF v_idem.request_hash <> p_request_hash THEN
            RAISE EXCEPTION 'Idempotency key mismatch with different payload' USING ERRCODE = '23505';
        END IF;
        RETURN v_idem.response_snapshot;
    END IF;

    -- 2. Заключване на искането за одобрение
    SELECT * INTO v_req FROM approval_requests
    WHERE id = p_request_id
    FOR UPDATE;

    IF NOT FOUND THEN
        RAISE EXCEPTION 'Approval request not found' USING ERRCODE = 'P0002';
    END IF;

    IF v_req.assignee_user_id <> p_actor_id THEN
        RAISE EXCEPTION 'User is not assigned decision maker' USING ERRCODE = '42501';
    END IF;

    IF v_req.status <> 'pending' THEN
        RAISE EXCEPTION 'Approval request is not pending' USING ERRCODE = '23514';
    END IF;

    IF v_req.expires_at <= NOW() THEN
        UPDATE approval_requests SET status = 'expired', updated_at = NOW() WHERE id = p_request_id;
        RAISE EXCEPTION 'Approval request has expired' USING ERRCODE = '23514';
    END IF;

    -- 3. Проверка на версията на предложението
    SELECT * INTO v_prop_ver FROM proposal_versions
    WHERE id = v_req.proposal_version_id;

    IF v_prop_ver.requires_budget_permission AND NOT can_read_budget(v_req.event_id, p_actor_id) THEN
        RAISE EXCEPTION 'User lacks required budget permission for this proposal' USING ERRCODE = '42501';
    END IF;

    -- Валидация на вариант
    IF p_decision = 'approved' AND p_selected_option_id IS NOT NULL THEN
        IF NOT EXISTS (
            SELECT 1 FROM proposal_options 
            WHERE id = p_selected_option_id AND proposal_version_id = v_prop_ver.id
        ) THEN
            RAISE EXCEPTION 'Selected option does not belong to submitted proposal version' USING ERRCODE = '23503';
        END IF;
    END IF;

    IF p_decision = 'changes_requested' AND (p_comment IS NULL OR length(trim(p_comment)) = 0) THEN
        RAISE EXCEPTION 'Comment is required when requesting changes' USING ERRCODE = '23514';
    END IF;

    -- 4. Запис на отговор
    INSERT INTO approval_responses (
        request_id, org_id, event_id, actor_user_id, decision, selected_option_id, comment, decided_at, request_hash
    ) VALUES (
        p_request_id, v_req.org_id, v_req.event_id, p_actor_id, p_decision, p_selected_option_id, p_comment, NOW(), p_request_hash
    ) RETURNING id INTO v_resp_id;

    -- 5. Обновяване на искането
    UPDATE approval_requests 
    SET status = p_decision, updated_at = NOW(), row_version = row_version + 1
    WHERE id = p_request_id;

    -- 6. Ако е одобрено бюджетно предложение -> атомарно активиране на бюджетната версия
    IF p_decision = 'approved' AND v_prop_ver.budget_version_id IS NOT NULL THEN
        -- Деактивиране на предходна активна версия
        UPDATE budget_versions 
        SET state = 'superseded', updated_at = NOW() 
        WHERE event_id = v_req.event_id AND state = 'active';

        -- Активиране на новата бюджетна версия
        UPDATE budget_versions 
        SET state = 'active', approved_response_id = v_resp_id, updated_at = NOW() 
        WHERE id = v_prop_ver.budget_version_id;
    END IF;

    -- 7. Одитен запис
    INSERT INTO audit_log (
        org_id, event_id, actor_id, actor_type, action, resource_type, resource_id, safe_diff
    ) VALUES (
        v_req.org_id, v_req.event_id, p_actor_id, 'user', 'approval_decision_' || p_decision, 'approval_request', p_request_id,
        jsonb_build_object('decision', p_decision, 'selectedOptionId', p_selected_option_id, 'proposalVersionId', v_prop_ver.id)
    );

    v_res := jsonb_build_object(
        'success', true,
        'requestId', p_request_id,
        'decision', p_decision,
        'responseId', v_resp_id,
        'decidedAt', NOW()
    );

    -- 8. Запис на ключ за идемпотентност
    INSERT INTO idempotency_keys (
        org_id, actor_id, operation, key, request_hash, response_snapshot, state, expires_at
    ) VALUES (
        v_req.org_id, p_actor_id, 'approval_response', p_idempotency_key, p_request_hash, v_res, 'completed', NOW() + INTERVAL '24 hours'
    );

    RETURN v_res;
END;
$$;
