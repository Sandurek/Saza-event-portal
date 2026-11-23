// src/domain/types.ts
// Домейнови типове и интерфейси според спецификацията

export type OrgRole = 'owner' | 'manager' | 'coordinator';
export type ClientRole = 'client_decision_maker' | 'client_viewer';
export type MemberType = 'staff' | 'client';
export type MembershipStatus = 'active' | 'suspended' | 'revoked';

export type EventType = 'corporate' | 'wedding' | 'personal' | 'other';
export type EventLifecycle = 'draft' | 'planning' | 'ready' | 'completed' | 'cancelled' | 'archived';

export type MilestoneStatus = 'planned' | 'in_progress' | 'awaiting_client' | 'confirmed' | 'not_applicable';
export type MilestoneHealth = 'normal' | 'at_risk' | 'delayed';
export type Criticality = 'low' | 'medium' | 'high' | 'critical';

export type TaskStatus = 'todo' | 'doing' | 'blocked' | 'done';
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';

export type ProposalKind = 'general' | 'option_selection' | 'budget';
export type ProposalVersionState = 'draft' | 'submitted' | 'superseded';
export type ApprovalRequestStatus = 'pending' | 'approved' | 'changes_requested' | 'expired' | 'withdrawn' | 'superseded';
export type ApprovalDecision = 'approved' | 'changes_requested';

export type BudgetVersionState = 'draft' | 'proposed' | 'active' | 'superseded';
export type PaymentScheduleState = 'pending' | 'partial' | 'paid' | 'overdue';

export type DocumentAudience = 'team' | 'client';
export type DocumentScanState = 'uploading' | 'quarantined' | 'ready' | 'rejected' | 'deleted';
export type DocumentMimeType = 'application/pdf' | 'image/jpeg' | 'image/png';

export type OutboxChannel = 'email' | 'sms' | 'push';
export type OutboxState = 'pending' | 'processing' | 'sent' | 'retry' | 'failed';

export interface UserSession {
  userId: string;
  displayName: string;
  email: string;
  orgId: string;
  orgRole?: OrgRole;
  isStaff: boolean;
  eventMemberships: {
    eventId: string;
    memberType: MemberType;
    clientRole?: ClientRole;
    canViewBudget: boolean;
    status: MembershipStatus;
    accessExpiresAt?: string | null;
  }[];
}

export interface OverviewMetrics {
  totalMilestones: number;
  confirmedMilestones: number;
  applicableMilestones: number;
  overallHealth: 'normal' | 'at_risk' | 'delayed' | 'needs_verification' | 'action_needed';
  primaryIssueText?: string;
  lastVerifiedAt?: string | null;
  lastPublishedAt?: string | null;
  pendingDecisionsCount: number;
  requiresClientAction: boolean;
  activeBudgetEUR?: string;
  proposedBudgetDiffEUR?: string;
}
