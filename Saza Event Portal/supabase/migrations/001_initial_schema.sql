-- 001_initial_schema.sql
-- Инициализиране на основните структури за организации, профили, събития и членства

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Таблица organizations
CREATE TABLE IF NOT EXISTS organizations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    name TEXT NOT NULL,
    brand_settings JSONB NOT NULL DEFAULT '{"agencyName": "Event Portal", "primaryColor": "#1e3a8a", "logoUrl": null}'::jsonb,
    timezone TEXT NOT NULL DEFAULT 'Europe/Sofia',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Таблица profiles
CREATE TABLE IF NOT EXISTS profiles (
    user_id UUID PRIMARY KEY,
    display_name TEXT NOT NULL,
    locale TEXT NOT NULL DEFAULT 'bg',
    timezone TEXT NOT NULL DEFAULT 'Europe/Sofia',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Таблица organization_memberships
CREATE TABLE IF NOT EXISTS organization_memberships (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    user_id UUID NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'manager', 'coordinator')),
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'suspended', 'revoked')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_org_user UNIQUE (org_id, user_id)
);

-- Таблица events
CREATE TABLE IF NOT EXISTS events (
    id UUID DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('corporate', 'wedding', 'personal', 'other')),
    starts_at TIMESTAMPTZ NOT NULL,
    ends_at TIMESTAMPTZ NOT NULL,
    timezone TEXT NOT NULL DEFAULT 'Europe/Sofia',
    venue_label TEXT,
    lifecycle TEXT NOT NULL DEFAULT 'draft' CHECK (lifecycle IN ('draft', 'planning', 'ready', 'completed', 'cancelled', 'archived')),
    primary_coordinator_id UUID REFERENCES profiles(user_id) ON DELETE SET NULL,
    archived_at TIMESTAMPTZ,
    row_version BIGINT NOT NULL DEFAULT 1,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    PRIMARY KEY (id),
    CONSTRAINT uq_event_org_id UNIQUE (org_id, id),
    CONSTRAINT chk_event_dates CHECK (ends_at >= starts_at)
);

CREATE INDEX IF NOT EXISTS idx_events_org_starts ON events(org_id, starts_at);

-- Таблица event_memberships
CREATE TABLE IF NOT EXISTS event_memberships (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL,
    event_id UUID NOT NULL,
    user_id UUID NOT NULL REFERENCES profiles(user_id) ON DELETE CASCADE,
    member_type TEXT NOT NULL CHECK (member_type IN ('staff', 'client')),
    client_role TEXT CHECK (client_role IS NULL OR client_role IN ('client_decision_maker', 'client_viewer')),
    can_view_budget BOOLEAN NOT NULL DEFAULT FALSE,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
    access_expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_event_user UNIQUE (event_id, user_id),
    CONSTRAINT fk_event_org_membership FOREIGN KEY (org_id, event_id) REFERENCES events(org_id, id) ON DELETE CASCADE,
    CONSTRAINT chk_client_role_consistency CHECK (
        (member_type = 'client' AND client_role IS NOT NULL) OR
        (member_type = 'staff' AND client_role IS NULL)
    )
);

CREATE INDEX IF NOT EXISTS idx_event_memberships_user ON event_memberships(user_id, status);

-- Таблица invitations
CREATE TABLE IF NOT EXISTS invitations (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('staff', 'client')),
    event_id UUID,
    normalized_email TEXT NOT NULL,
    intended_role TEXT NOT NULL CHECK (intended_role IN ('owner', 'manager', 'coordinator', 'client_decision_maker', 'client_viewer')),
    budget_permission BOOLEAN NOT NULL DEFAULT FALSE,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at TIMESTAMPTZ NOT NULL,
    accepted_at TIMESTAMPTZ,
    revoked_at TIMESTAMPTZ,
    invited_by UUID NOT NULL REFERENCES profiles(user_id),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT chk_invitation_event CHECK (
        (kind = 'client' AND event_id IS NOT NULL) OR
        (kind = 'staff' AND event_id IS NULL)
    ),
    CONSTRAINT fk_invitation_event_org FOREIGN KEY (org_id, event_id) REFERENCES events(org_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_invitations_email ON invitations(normalized_email);
