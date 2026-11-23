-- 002_milestones_and_tasks.sql
-- Шаблони, етапи, вътрешни задачи, зависимости и клиентски обновявания

-- Таблица event_templates
CREATE TABLE IF NOT EXISTS event_templates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('corporate', 'wedding', 'personal', 'other')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    current_version_id UUID,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Таблица template_versions
CREATE TABLE IF NOT EXISTS template_versions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    template_id UUID NOT NULL REFERENCES event_templates(id) ON DELETE CASCADE,
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    version_no INTEGER NOT NULL,
    schema_version INTEGER NOT NULL DEFAULT 1,
    definition_json JSONB NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_template_version UNIQUE (template_id, version_no)
);

-- Таблица milestones (клиентски етапи)
CREATE TABLE IF NOT EXISTS milestones (
    id UUID DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL,
    event_id UUID NOT NULL,
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    sort_order INTEGER NOT NULL DEFAULT 0,
    assigned_to UUID REFERENCES profiles(user_id) ON DELETE SET NULL,
    due_date DATE,
    timezone TEXT NOT NULL DEFAULT 'Europe/Sofia',
    is_required BOOLEAN NOT NULL DEFAULT TRUE,
    criticality TEXT NOT NULL DEFAULT 'medium' CHECK (criticality IN ('low', 'medium', 'high', 'critical')),
    is_relative BOOLEAN NOT NULL DEFAULT FALSE,
    offset_days INTEGER,
    status TEXT NOT NULL DEFAULT 'planned' CHECK (status IN ('planned', 'in_progress', 'awaiting_client', 'confirmed', 'not_applicable')),
    health TEXT NOT NULL DEFAULT 'normal' CHECK (health IN ('normal', 'at_risk', 'delayed')),
    next_step TEXT,
    completion_rule TEXT,
    published_at TIMESTAMPTZ,
    last_verified_at TIMESTAMPTZ,
    row_version BIGINT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id),
    CONSTRAINT uq_milestone_event_id UNIQUE (org_id, event_id, id),
    CONSTRAINT fk_milestone_event FOREIGN KEY (org_id, event_id) REFERENCES events(org_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_milestones_event_sort ON milestones(event_id, sort_order);

-- Таблица milestone_drafts (само за екипа)
CREATE TABLE IF NOT EXISTS milestone_drafts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    milestone_id UUID NOT NULL,
    org_id UUID NOT NULL,
    event_id UUID NOT NULL,
    draft_json JSONB NOT NULL,
    edited_by UUID NOT NULL REFERENCES profiles(user_id),
    row_version BIGINT NOT NULL DEFAULT 1,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_draft_milestone UNIQUE (milestone_id),
    CONSTRAINT fk_draft_milestone FOREIGN KEY (org_id, event_id, milestone_id) REFERENCES milestones(org_id, event_id, id) ON DELETE CASCADE
);

-- Таблица tasks (вътрешни задачи)
CREATE TABLE IF NOT EXISTS tasks (
    id UUID DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL,
    event_id UUID NOT NULL,
    milestone_id UUID,
    title TEXT NOT NULL,
    internal_description TEXT,
    assignee_id UUID REFERENCES profiles(user_id) ON DELETE SET NULL,
    due_at TIMESTAMPTZ,
    status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'doing', 'blocked', 'done')),
    priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
    blocked_reason TEXT,
    row_version BIGINT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id),
    CONSTRAINT uq_task_event_id UNIQUE (org_id, event_id, id),
    CONSTRAINT fk_task_event FOREIGN KEY (org_id, event_id) REFERENCES events(org_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_task_milestone FOREIGN KEY (org_id, event_id, milestone_id) REFERENCES milestones(org_id, event_id, id) ON DELETE SET NULL,
    CONSTRAINT chk_blocked_reason CHECK (
        (status = 'blocked' AND blocked_reason IS NOT NULL AND blocked_reason <> '') OR
        (status <> 'blocked')
    )
);

CREATE INDEX IF NOT EXISTS idx_tasks_event_status_due ON tasks(event_id, status, due_at);

-- Таблица task_dependencies
CREATE TABLE IF NOT EXISTS task_dependencies (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL,
    event_id UUID NOT NULL,
    task_id UUID NOT NULL,
    depends_on_task_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_task_dependency UNIQUE (task_id, depends_on_task_id),
    CONSTRAINT chk_no_self_dependency CHECK (task_id <> depends_on_task_id),
    CONSTRAINT fk_dep_task FOREIGN KEY (org_id, event_id, task_id) REFERENCES tasks(org_id, event_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_dep_depends_on FOREIGN KEY (org_id, event_id, depends_on_task_id) REFERENCES tasks(org_id, event_id, id) ON DELETE CASCADE
);

-- Таблица published_updates (непроменяема клиентска история)
CREATE TABLE IF NOT EXISTS published_updates (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL,
    event_id UUID NOT NULL,
    milestone_id UUID,
    sequence_no INTEGER NOT NULL,
    public_text TEXT NOT NULL,
    snapshot_json JSONB NOT NULL,
    published_by UUID NOT NULL REFERENCES profiles(user_id),
    published_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    requires_budget_permission BOOLEAN NOT NULL DEFAULT FALSE,
    CONSTRAINT fk_update_event FOREIGN KEY (org_id, event_id) REFERENCES events(org_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_update_milestone FOREIGN KEY (org_id, event_id, milestone_id) REFERENCES milestones(org_id, event_id, id) ON DELETE SET NULL,
    CONSTRAINT uq_update_seq UNIQUE (event_id, sequence_no)
);

CREATE INDEX IF NOT EXISTS idx_published_updates_event_pub ON published_updates(event_id, published_at);

-- Таблица change_requests (клиентски искания за промяна)
CREATE TABLE IF NOT EXISTS change_requests (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL,
    event_id UUID NOT NULL,
    milestone_id UUID,
    requested_by UUID NOT NULL REFERENCES profiles(user_id),
    description TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'under_review', 'approved', 'declined')),
    proposed_impact TEXT,
    linked_proposal_id UUID,
    resolved_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_change_req_event FOREIGN KEY (org_id, event_id) REFERENCES events(org_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_change_req_milestone FOREIGN KEY (org_id, event_id, milestone_id) REFERENCES milestones(org_id, event_id, id) ON DELETE SET NULL
);
