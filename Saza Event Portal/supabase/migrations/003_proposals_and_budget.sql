-- 003_proposals_and_budget.sql
-- Предложения, версии, варианти, транзакционни одобрения, бюджет и плащания

-- Таблица proposals
CREATE TABLE IF NOT EXISTS proposals (
    id UUID DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL,
    event_id UUID NOT NULL,
    milestone_id UUID,
    kind TEXT NOT NULL CHECK (kind IN ('general', 'option_selection', 'budget')),
    title TEXT NOT NULL,
    current_version_id UUID,
    row_version BIGINT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id),
    CONSTRAINT uq_proposal_event_id UNIQUE (org_id, event_id, id),
    CONSTRAINT fk_proposal_event FOREIGN KEY (org_id, event_id) REFERENCES events(org_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_proposal_milestone FOREIGN KEY (org_id, event_id, milestone_id) REFERENCES milestones(org_id, event_id, id) ON DELETE SET NULL
);

-- Таблица proposal_versions
CREATE TABLE IF NOT EXISTS proposal_versions (
    id UUID DEFAULT uuid_generate_v4(),
    proposal_id UUID NOT NULL,
    org_id UUID NOT NULL,
    event_id UUID NOT NULL,
    version_no INTEGER NOT NULL,
    body_json JSONB NOT NULL,
    content_hash TEXT NOT NULL,
    state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'submitted', 'superseded')),
    requires_budget_permission BOOLEAN NOT NULL DEFAULT FALSE,
    budget_version_id UUID,
    submitted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id),
    CONSTRAINT uq_proposal_ver_event UNIQUE (org_id, event_id, id),
    CONSTRAINT uq_proposal_version_no UNIQUE (proposal_id, version_no),
    CONSTRAINT fk_version_proposal FOREIGN KEY (org_id, event_id, proposal_id) REFERENCES proposals(org_id, event_id, id) ON DELETE CASCADE
);

-- Таблица proposal_options
CREATE TABLE IF NOT EXISTS proposal_options (
    id UUID DEFAULT uuid_generate_v4(),
    proposal_version_id UUID NOT NULL,
    org_id UUID NOT NULL,
    event_id UUID NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    total_cents BIGINT,
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id),
    CONSTRAINT uq_prop_opt_event UNIQUE (org_id, event_id, id),
    CONSTRAINT fk_opt_version FOREIGN KEY (org_id, event_id, proposal_version_id) REFERENCES proposal_versions(org_id, event_id, id) ON DELETE CASCADE
);

-- Таблица approval_requests
CREATE TABLE IF NOT EXISTS approval_requests (
    id UUID DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL,
    event_id UUID NOT NULL,
    proposal_id UUID NOT NULL,
    proposal_version_id UUID NOT NULL,
    assignee_user_id UUID NOT NULL REFERENCES profiles(user_id),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'changes_requested', 'expired', 'withdrawn', 'superseded')),
    expires_at TIMESTAMPTZ NOT NULL,
    row_version BIGINT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id),
    CONSTRAINT uq_req_event_id UNIQUE (org_id, event_id, id),
    CONSTRAINT fk_req_event FOREIGN KEY (org_id, event_id) REFERENCES events(org_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_req_proposal FOREIGN KEY (org_id, event_id, proposal_id) REFERENCES proposals(org_id, event_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_req_version FOREIGN KEY (org_id, event_id, proposal_version_id) REFERENCES proposal_versions(org_id, event_id, id) ON DELETE CASCADE
);

-- Частичен уникален индекс: Само ЕДНО pending искане за предложение
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_pending_request_per_proposal 
ON approval_requests(proposal_id) 
WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_approval_requests_assignee ON approval_requests(assignee_user_id, status, expires_at);

-- Таблица approval_responses (непроменяем отговор от клиент)
CREATE TABLE IF NOT EXISTS approval_responses (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    request_id UUID NOT NULL UNIQUE,
    org_id UUID NOT NULL,
    event_id UUID NOT NULL,
    actor_user_id UUID NOT NULL REFERENCES profiles(user_id),
    decision TEXT NOT NULL CHECK (decision IN ('approved', 'changes_requested')),
    selected_option_id UUID,
    comment TEXT,
    decided_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    request_hash TEXT NOT NULL,
    CONSTRAINT fk_resp_request FOREIGN KEY (org_id, event_id, request_id) REFERENCES approval_requests(org_id, event_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_resp_option FOREIGN KEY (org_id, event_id, selected_option_id) REFERENCES proposal_options(org_id, event_id, id) ON DELETE SET NULL,
    CONSTRAINT chk_changes_req_comment CHECK (
        (decision = 'changes_requested' AND comment IS NOT NULL AND length(trim(comment)) > 0) OR
        (decision = 'approved')
    )
);

-- Таблица budget_versions
CREATE TABLE IF NOT EXISTS budget_versions (
    id UUID DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL,
    event_id UUID NOT NULL,
    version_no INTEGER NOT NULL,
    state TEXT NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'proposed', 'active', 'superseded')),
    currency TEXT NOT NULL DEFAULT 'EUR',
    total_cents BIGINT NOT NULL DEFAULT 0 CHECK (total_cents >= 0),
    base_version_id UUID,
    approved_response_id UUID REFERENCES approval_responses(id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id),
    CONSTRAINT uq_budget_ver_event UNIQUE (org_id, event_id, id),
    CONSTRAINT uq_event_budget_ver_no UNIQUE (event_id, version_no),
    CONSTRAINT fk_budget_event FOREIGN KEY (org_id, event_id) REFERENCES events(org_id, id) ON DELETE CASCADE
);

-- Частичен уникален индекс: Само ЕДНА active бюджетна версия за събитие
CREATE UNIQUE INDEX IF NOT EXISTS uq_one_active_budget_per_event 
ON budget_versions(event_id) 
WHERE state = 'active';

-- Таблица budget_items
CREATE TABLE IF NOT EXISTS budget_items (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    budget_version_id UUID NOT NULL,
    org_id UUID NOT NULL,
    event_id UUID NOT NULL,
    category TEXT NOT NULL,
    client_description TEXT NOT NULL,
    total_cents BIGINT NOT NULL CHECK (total_cents >= 0),
    sort_order INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_item_version FOREIGN KEY (org_id, event_id, budget_version_id) REFERENCES budget_versions(org_id, event_id, id) ON DELETE CASCADE
);

-- Таблица internal_costs (само за екипа, строго забранена за клиента)
CREATE TABLE IF NOT EXISTS internal_costs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL,
    event_id UUID NOT NULL,
    budget_item_id UUID,
    supplier_name TEXT NOT NULL,
    cost_cents BIGINT NOT NULL CHECK (cost_cents >= 0),
    internal_note TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_internal_cost_event FOREIGN KEY (org_id, event_id) REFERENCES events(org_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_internal_cost_item FOREIGN KEY (budget_item_id) REFERENCES budget_items(id) ON DELETE SET NULL
);

-- Таблица payment_schedules (планирани плащания)
CREATE TABLE IF NOT EXISTS payment_schedules (
    id UUID DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL,
    event_id UUID NOT NULL,
    label TEXT NOT NULL,
    amount_cents BIGINT NOT NULL CHECK (amount_cents > 0),
    due_date DATE NOT NULL,
    state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'partial', 'paid', 'overdue')),
    row_version BIGINT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id),
    CONSTRAINT uq_sched_event_id UNIQUE (org_id, event_id, id),
    CONSTRAINT fk_sched_event FOREIGN KEY (org_id, event_id) REFERENCES events(org_id, id) ON DELETE CASCADE
);

-- Таблица payment_entries (потвърдени финансови записи и корекции)
CREATE TABLE IF NOT EXISTS payment_entries (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL,
    event_id UUID NOT NULL,
    schedule_id UUID,
    signed_amount_cents BIGINT NOT NULL, -- положителен за плащане, отрицателен за сторно
    effective_date DATE NOT NULL,
    reference TEXT,
    reversal_of_id UUID REFERENCES payment_entries(id),
    recorded_by UUID NOT NULL REFERENCES profiles(user_id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_payment_event FOREIGN KEY (org_id, event_id) REFERENCES events(org_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_payment_schedule FOREIGN KEY (org_id, event_id, schedule_id) REFERENCES payment_schedules(org_id, event_id, id) ON DELETE SET NULL,
    CONSTRAINT chk_reversal_validity CHECK (
        (signed_amount_cents < 0 AND reversal_of_id IS NOT NULL) OR
        (signed_amount_cents > 0 AND reversal_of_id IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_payment_entries_event ON payment_entries(event_id, effective_date);
