// src/domain/rules.ts
// Домейнови правила за валидация, пресмятане на срокове, бюджети и актуалност

import crypto from 'node:crypto';
import type { MilestoneStatus, MilestoneHealth } from './types.ts';


/**
 * Проверка за просрочие на етап.
 * Ако етапът не е confirmed или not_applicable, и dueDate е преди днешния ден (по местно време), той е просрочен.
 */
export function isMilestoneOverdue(
  dueDateStr: string | null | undefined,
  status: MilestoneStatus,
  currentDateStr: string // YYYY-MM-DD
): boolean {
  if (!dueDateStr) return false;

  if (status === 'confirmed' || status === 'not_applicable') return false;
  return dueDateStr < currentDateStr;
}

/**
 * Проверка за остаряла проверка (Section 7.3):
 * - Поне веднъж на 7 дни по подразбиране.
 * - През последните 14 дни преди събитието: поне веднъж на 48 часа (2 дни).
 */
export function isVerificationStale(
  lastVerifiedAt: string | null | undefined,
  eventStartsAt: string,
  nowIso: string
): boolean {
  if (!lastVerifiedAt) return true;

  const now = new Date(nowIso).getTime();
  const lastVerified = new Date(lastVerifiedAt).getTime();
  const eventStart = new Date(eventStartsAt).getTime();

  const msToEvent = eventStart - now;
  const daysToEvent = msToEvent / (1000 * 60 * 60 * 24);

  const hoursSinceVerification = (now - lastVerified) / (1000 * 60 * 60);

  if (daysToEvent <= 14 && daysToEvent >= 0) {
    // Последните 14 дни: на всеки 48 часа
    return hoursSinceVerification > 48;
  } else {
    // Обичайно: на всеки 7 дни (168 часа)
    return hoursSinceVerification > 168;
  }
}

/**
 * Определяне на общото състояние на събитието по приоритет (Section 7.3):
 * 1. Отменено или приключено събитие
 * 2. Действително забавяне (delayed)
 * 3. Известен риск (at_risk)
 * 4. Остаряла проверка (needs_verification)
 * 5. Предстоящо клиентско действие (awaiting_client)
 * 6. По план (normal)
 */
export function calculateOverallHealth(params: {
  eventLifecycle: string;
  milestones: { status: MilestoneStatus; health: MilestoneHealth; dueDate?: string | null }[];
  lastVerifiedAt?: string | null;
  eventStartsAt: string;
  nowIso: string;
  hasPendingClientDecisions: boolean;
}): {
  overallHealth: 'normal' | 'at_risk' | 'delayed' | 'needs_verification' | 'action_needed' | 'completed' | 'cancelled';
  statusText: string;
  isStale: boolean;
} {
  const { eventLifecycle, milestones, lastVerifiedAt, eventStartsAt, nowIso, hasPendingClientDecisions } = params;

  if (eventLifecycle === 'cancelled') {
    return { overallHealth: 'cancelled', statusText: 'Събитието е отменено', isStale: false };
  }
  if (eventLifecycle === 'completed' || eventLifecycle === 'archived') {
    return { overallHealth: 'completed', statusText: 'Събитието е приключено', isStale: false };
  }

  const currentDateStr = nowIso.slice(0, 10);
  const hasDelayed = milestones.some(m => m.health === 'delayed' || isMilestoneOverdue(m.dueDate, m.status, currentDateStr));
  if (hasDelayed) {
    return { overallHealth: 'delayed', statusText: 'Има регистрирано забавяне по графика', isStale: false };
  }

  const hasAtRisk = milestones.some(m => m.health === 'at_risk');
  if (hasAtRisk) {
    return { overallHealth: 'at_risk', statusText: 'Има етапи с потенциален риск', isStale: false };
  }

  const isStale = isVerificationStale(lastVerifiedAt, eventStartsAt, nowIso);
  if (isStale) {
    return { overallHealth: 'needs_verification', statusText: 'Нужна е актуализация на данните от координатора', isStale: true };
  }

  if (hasPendingClientDecisions) {
    return { overallHealth: 'action_needed', statusText: 'Очаква се ваше решение', isStale: false };
  }

  return { overallHealth: 'normal', statusText: 'Организацията се движи по план', isStale: false };
}

/**
 * Форматиране на парична стойност в евро (от евроцентове).
 */
export function formatCentsToEUR(cents: number | bigint): string {
  const num = Number(cents);
  const euros = (num / 100).toFixed(2);
  const parts = euros.split('.');
  parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
  return `${parts.join(',')} €`;
}

/**
 * Изчисляване на хеш на тялото на предложението (SHA-256)
 */
export function computeContentHash(content: unknown): string {
  const str = typeof content === 'string' ? content : JSON.stringify(content);
  return crypto.createHash('sha256').update(str).digest('hex');
}
