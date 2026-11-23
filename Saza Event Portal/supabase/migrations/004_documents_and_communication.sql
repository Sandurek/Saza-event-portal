-- 004_documents_and_communication.sql
-- Документи, файлови версии, прикачени файлове, нишки, коментари и известия

-- Таблица documents
CREATE TABLE IF NOT EXISTS documents (
    id UUID DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL,
    event_id UUID NOT NULL,
    title TEXT NOT NULL,
    category TEXT NOT NULL,
    audience TEXT NOT NULL DEFAULT 'client' CHECK (audience IN ('team', 'client')),
    requires_budget_permission BOOLEAN NOT NULL DEFAULT FALSE,
    current_version_id UUID,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id),
    CONSTRAINT uq_doc_event_id UNIQUE (org_id, event_id, id),
    CONSTRAINT fk_doc_event FOREIGN KEY (org_id, event_id) REFERENCES events(org_id, id) ON DELETE CASCADE
);

-- Таблица document_versions
CREATE TABLE IF NOT EXISTS document_versions (
    id UUID DEFAULT uuid_generate_v4(),
    document_id UUID NOT NULL,
    org_id UUID NOT NULL,
    event_id UUID NOT NULL,
    version_no INTEGER NOT NULL,
    object_key TEXT NOT NULL UNIQUE,
    original_name TEXT NOT NULL,
    mime_type TEXT NOT NULL CHECK (mime_type IN ('application/pdf', 'image/jpeg', 'image/png')),
    byte_size BIGINT NOT NULL CHECK (byte_size > 0 AND byte_size <= 20971520), -- до 20 MiB
    sha256 TEXT NOT NULL,
    scan_state TEXT NOT NULL DEFAULT 'quarantined' CHECK (scan_state IN ('uploading', 'quarantined', 'ready', 'rejected', 'deleted')),
    uploaded_by UUID NOT NULL REFERENCES profiles(user_id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id),
    CONSTRAINT uq_doc_ver_event UNIQUE (org_id, event_id, id),
    CONSTRAINT uq_doc_version_no UNIQUE (document_id, version_no),
    CONSTRAINT fk_ver_document FOREIGN KEY (org_id, event_id, document_id) REFERENCES documents(org_id, event_id, id) ON DELETE CASCADE
);

-- Таблица proposal_attachments
CREATE TABLE IF NOT EXISTS proposal_attachments (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL,
    event_id UUID NOT NULL,
    proposal_version_id UUID NOT NULL,
    document_version_id UUID NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_prop_attachment UNIQUE (proposal_version_id, document_version_id),
    CONSTRAINT fk_att_proposal_ver FOREIGN KEY (org_id, event_id, proposal_version_id) REFERENCES proposal_versions(org_id, event_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_att_doc_ver FOREIGN KEY (org_id, event_id, document_version_id) REFERENCES document_versions(org_id, event_id, id) ON DELETE CASCADE
);

-- Таблица threads (дискусии по контекст)
CREATE TABLE IF NOT EXISTS threads (
    id UUID DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL,
    event_id UUID NOT NULL,
    milestone_id UUID,
    proposal_version_id UUID,
    document_id UUID,
    audience TEXT NOT NULL DEFAULT 'client' CHECK (audience IN ('team', 'client')),
    requires_budget_permission BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id),
    CONSTRAINT uq_thread_event_id UNIQUE (org_id, event_id, id),
    CONSTRAINT fk_thread_event FOREIGN KEY (org_id, event_id) REFERENCES events(org_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_thread_milestone FOREIGN KEY (org_id, event_id, milestone_id) REFERENCES milestones(org_id, event_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_thread_proposal_ver FOREIGN KEY (org_id, event_id, proposal_version_id) REFERENCES proposal_versions(org_id, event_id, id) ON DELETE CASCADE,
    CONSTRAINT fk_thread_doc FOREIGN KEY (org_id, event_id, document_id) REFERENCES documents(org_id, event_id, id) ON DELETE CASCADE,
    -- CHECK: threads допуска общ разговор за събитието без предмет или точно един от milestone, proposal_version, document
    CONSTRAINT chk_thread_single_subject CHECK (
        (CASE WHEN milestone_id IS NOT NULL THEN 1 ELSE 0 END +
         CASE WHEN proposal_version_id IS NOT NULL THEN 1 ELSE 0 END +
         CASE WHEN document_id IS NOT NULL THEN 1 ELSE 0 END) <= 1
    )
);

-- Таблица comments
CREATE TABLE IF NOT EXISTS comments (
    id UUID DEFAULT uuid_generate_v4(),
    thread_id UUID NOT NULL,
    org_id UUID NOT NULL,
    event_id UUID NOT NULL,
    author_id UUID NOT NULL REFERENCES profiles(user_id),
    body TEXT NOT NULL,
    edited_at TIMESTAMPTZ,
    deleted_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id),
    CONSTRAINT uq_comment_event_id UNIQUE (org_id, event_id, id),
    CONSTRAINT fk_comment_thread FOREIGN KEY (org_id, event_id, thread_id) REFERENCES threads(org_id, event_id, id) ON DELETE CASCADE
);

-- Таблица comment_revisions (само за екипа, при редакция)
CREATE TABLE IF NOT EXISTS comment_revisions (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    comment_id UUID NOT NULL,
    org_id UUID NOT NULL,
    event_id UUID NOT NULL,
    previous_body TEXT NOT NULL,
    changed_by UUID NOT NULL REFERENCES profiles(user_id),
    reason TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT fk_rev_comment FOREIGN KEY (org_id, event_id, comment_id) REFERENCES comments(org_id, event_id, id) ON DELETE CASCADE
);

-- Таблица notifications (известия в портала)
CREATE TABLE IF NOT EXISTS notifications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    event_id UUID REFERENCES events(id) ON DELETE CASCADE,
    recipient_id UUID NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    safe_payload JSONB NOT NULL,
    read_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_notifications_recipient ON notifications(recipient_id, read_at, created_at);

-- Таблица notification_preferences
CREATE TABLE IF NOT EXISTS notification_preferences (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    user_id UUID NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    progress_mode TEXT NOT NULL DEFAULT 'immediate_decisions_daily_digest' CHECK (progress_mode IN ('all_immediate', 'immediate_decisions_daily_digest', 'digest_only', 'none')),
    digest_local_time TEXT NOT NULL DEFAULT '18:00',
    timezone TEXT NOT NULL DEFAULT 'Europe/Sofia',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_user_org_pref UNIQUE (user_id, org_id)
);
