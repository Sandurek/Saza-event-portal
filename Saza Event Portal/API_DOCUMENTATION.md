# API Документация (API_DOCUMENTATION.md)

Пълна спецификация на всички REST API ендпойнти на **Saza Event Portal** съгласно Раздел 16.2 от Спецификацията.

---

## Обща информация

| Атрибут | Стойност |
|---|---|
| **Базов URL (продукция)** | `https://portal.sazaevents.com/api` |
| **Формат на данните** | `application/json` |
| **Автентикация** | Bearer токен в заглавие `Authorization: Bearer <token>` |
| **Часова зона** | Всички дати и времена са в **ISO 8601 UTC** (`2026-10-12T10:00:00.000Z`) |
| **Парични суми** | Всички суми се изразяват в **целочислени евроцентове** (напр. `500000` = 5 000,00 EUR) |

---

## Стандартни кодове за грешка

| HTTP код | Тип грешка | Описание |
|---|---|---|
| `400` | `VALIDATION_ERROR` | Невалидни или непълни входни данни |
| `401` | `UNAUTHORIZED` | Липсваща или невалидна автентикация |
| `403` | `FORBIDDEN` | Нямате необходимите права за тази операция |
| `404` | `NOT_FOUND` | Ресурсът не съществува или не е достъпен от вашата организация |
| `409` | `CONFLICT` | Конкурентен запис (параллелно решение, дублиран idempotency_key) |
| `422` | `BUSINESS_RULE_VIOLATION` | Нарушено бизнес правило (напр. отмяна надвишава сумата) |
| `429` | `RATE_LIMIT_EXCEEDED` | Превишена честота на заявки |
| `500` | `INTERNAL_ERROR` | Вътрешна грешка — свържете се с поддръжката |

### Формат на грешка
```json
{
  "error": {
    "code": "FORBIDDEN",
    "message": "Нямате право да виждате бюджетна информация за това събитие.",
    "correlationId": "corr-a1b2c3d4"
  }
}
```

---

## 1. Събития (Events)

### `POST /api/orgs/:orgId/events`
Създаване на ново събитие.

**Права**: `owner`, `manager` на организацията.

**Заявка:**
```json
{
  "title": "Сватбено тържество на Елена и Виктор",
  "eventType": "wedding",
  "startsAt": "2026-11-26T14:00:00.000Z",
  "endsAt": "2026-11-26T23:00:00.000Z",
  "timezone": "Europe/Sofia",
  "venueLabel": "Резиденция Тера, София",
  "primaryCoordinatorId": "usr-konstantin-01"
}
```

**Отговор `201 Created`:**
```json
{
  "eventId": "evt-a1b2c3d4-..."
}
```

---

### `GET /api/orgs/:orgId/events/:eventId`
Пълен преглед на събитие за служителите.

**Права**: `owner`, `manager`, `coordinator` в тази организация.

**Отговор `200 OK`:**
```json
{
  "id": "evt-wedding-aaa-01",
  "title": "Сватбено тържество на Елена и Виктор",
  "eventType": "wedding",
  "lifecycle": "planning",
  "startsAt": "2026-11-26T14:00:00.000Z",
  "endsAt": "2026-11-26T23:00:00.000Z",
  "venueLabel": "Резиденция Тера, София",
  "timezone": "Europe/Sofia",
  "primaryCoordinatorId": "usr-konstantin-01",
  "createdAt": "2026-10-12T10:00:00.000Z",
  "updatedAt": "2026-10-12T10:00:00.000Z"
}
```

---

### `GET /api/orgs/:orgId/events/:eventId/overview`
**Клиентски обзор** — отговаря на 4-те ключови въпроса (Раздел 6.2).

> [!IMPORTANT]
> Клиентският DTO **никога** не съдържа вътрешни бележки, разходи за доставчици, маржове или непубликувани етапи.

**Права**: Активно членство в събитието (staff или client с `status = active`).

**Отговор `200 OK`:**
```json
{
  "event": {
    "id": "evt-wedding-aaa-01",
    "title": "Сватбено тържество на Елена и Виктор",
    "startsAt": "2026-11-26T14:00:00.000Z",
    "venueLabel": "Резиденция Тера, София",
    "lifecycle": "planning"
  },
  "overview": {
    "overallHealth": "needs_verification",
    "statusText": "Нужна е актуализация на данните от координатора",
    "isStale": true,
    "lastVerifiedAt": "2026-10-04T10:00:00.000Z",
    "lastPublishedAt": "2026-10-10T14:30:00.000Z",
    "totalMilestones": 5,
    "confirmedMilestones": 1,
    "pendingDecisionsCount": 1,
    "requiresClientAction": true
  },
  "publishedMilestones": [
    {
      "id": "mls-venue-01",
      "title": "Избор и резервация на локация",
      "category": "Локация",
      "status": "confirmed",
      "health": "normal",
      "nextStep": "Договорът е подписан и депозитът е платен",
      "dueDate": "2026-09-27"
    }
  ]
}
```

---

### `PATCH /api/orgs/:orgId/events/:eventId`
Промяна на информацията или жизнения цикъл на събитието.

**Права**: `owner`, `manager`.

**Заявка (примерно отлагане):**
```json
{
  "lifecycle": "rescheduled",
  "startsAt": "2026-12-10T14:00:00.000Z",
  "endsAt": "2026-12-10T23:00:00.000Z"
}
```

**Отговор `200 OK`:**
```json
{ "updated": true }
```

---

## 2. Членства и покани (Memberships & Invitations)

### `POST /api/orgs/:orgId/events/:eventId/invitations`
Изпращане на покана за клиент към събитие.

**Права**: `owner`, `manager`.

**Заявка:**
```json
{
  "email": "elena@example.test",
  "memberType": "client",
  "clientRole": "client_decision_maker",
  "canViewBudget": true
}
```

**Отговор `201 Created`:**
```json
{
  "invitationId": "inv-a1b2c3d4",
  "expiresAt": "2026-10-15T10:00:00.000Z"
}
```

> [!NOTE]
> Поканата е валидна **72 часа**. Токенът се изпраща по имейл и е еднократен (SHA-256 хеш).

---

### `POST /api/invitations/:token/accept`
Активиране на покана (приемане от клиента).

**Права**: Публичен ендпойнт (само токенът е необходим).

**Заявка:**
```json
{
  "userId": "usr-elena-01"
}
```

**Отговор `200 OK`:**
```json
{
  "membershipId": "mem-a1b2c3d4",
  "eventId": "evt-wedding-aaa-01",
  "portalUrl": "/portal/evt-wedding-aaa-01"
}
```

**Грешки:**
- `404 NOT_FOUND` — токенът не съществува.
- `422 BUSINESS_RULE_VIOLATION` — поканата е изтекла или вече е активирана.

---

### `DELETE /api/orgs/:orgId/memberships/:membershipId`
Незабавно прекратяване на достъпа.

**Права**: `owner`.

**Отговор `200 OK`:**
```json
{ "revoked": true, "effectiveAt": "2026-10-12T14:30:00.000Z" }
```

> [!WARNING]
> Следващата активна сесия на потребителя получава `403 Forbidden` незабавно, без изчакване.

---

## 3. Етапи (Milestones)

### `POST /api/orgs/:orgId/events/:eventId/milestones`
Създаване на нов етап (чернова).

**Права**: `coordinator`, `manager`, `owner`.

**Заявка:**
```json
{
  "title": "Флорална концепция и декорация",
  "category": "Декорация",
  "criticality": "high",
  "dueDate": "2026-10-22",
  "nextStep": "Контакт с флориста за потвърждение на наличността"
}
```

**Отговор `201 Created`:**
```json
{ "milestoneId": "mls-decor-02" }
```

---

### `POST /api/orgs/:orgId/milestones/:milestoneId/publish`
Атомарно публикуване на чернова на клиентите.

**Права**: `coordinator`, `manager`, `owner`.

> [!IMPORTANT]
> Публикуването е **атомарна транзакция**: актуализира `published_updates` и записва известие в `notification_outbox` в **една база-данни транзакция**. При срив на системата не е възможна частична публикация.

**Заявка:**
```json
{
  "publishedStatus": "in_progress",
  "publishedHealth": "at_risk",
  "publishedNextStep": "Очаква се потвърждение на наличност на цветята от вносителя"
}
```

**Отговор `200 OK`:**
```json
{
  "publishedAt": "2026-10-12T11:00:00.000Z",
  "outboxEntryId": "outbox-a1b2c3d4"
}
```

---

### `POST /api/orgs/:orgId/events/:eventId/verify`
Потвърждаване на актуалност от координатора.

**Права**: `coordinator`, `manager`, `owner`.

**Отговор `200 OK`:**
```json
{ "verifiedAt": "2026-10-12T11:00:00.000Z" }
```

---

## 4. Предложения и решения (Proposals & Approvals)

### `POST /api/orgs/:orgId/events/:eventId/proposals`
Създаване на ново предложение.

**Права**: `coordinator`, `manager`, `owner`.

**Заявка:**
```json
{
  "title": "Финално меню за сватбата",
  "kind": "option_selection",
  "options": [
    {
      "label": "Вариант 1: 4-степенно меню с риба",
      "descriptionMd": "Включва **морски дарове** и вегетариански опции...",
      "priceCents": 75000
    },
    {
      "label": "Вариант 2: 3-степенно класическо",
      "descriptionMd": "Класическо меню с месо и салати...",
      "priceCents": 60000
    }
  ],
  "deadlineAt": "2026-10-15T23:59:00.000Z"
}
```

**Отговор `201 Created`:**
```json
{
  "proposalId": "prop-menu-v1",
  "versionNumber": 1,
  "approvalRequestId": "apr-menu-v1-req"
}
```

---

### `POST /api/approvals/:approvalRequestId/respond`
Вземане на решение от клиент (одобрение или искане за промяна).

**Права**: Активен член с роля `client_decision_maker` и `status = active`.

**Заявка:**
```json
{
  "decision": "approved",
  "selectedOptionId": "opt-menu-v2-1",
  "commentMd": "Одобряваме Вариант 1 с морски дарове. Потвърждаваме и вегетарианска опция за 4 гости.",
  "idempotencyKey": "client-elena-approve-menu-20261012"
}
```

**Отговор `200 OK`:**
```json
{
  "responseId": "apr-resp-a1b2c3",
  "decision": "approved",
  "selectedOptionId": "opt-menu-v2-1",
  "contentHash": "sha256:a3f1b2c4d5...",
  "recordedAt": "2026-10-12T11:15:00.000Z"
}
```

**Грешки:**
- `403 FORBIDDEN` — потребителят е `client_viewer` или достъпът е отнет.
- `409 CONFLICT` — конкурентно решение от друг потребител е записано на същия ресурс.
- `200 OK` (повторна заявка) — при повторно изпращане на **същия** `idempotencyKey` се връща оригиналният отговор без дублиране.
- `422 BUSINESS_RULE_VIOLATION` — предложението е изтекло или оттеглено.

---

## 5. Бюджет и плащания (Budget & Payments)

### `GET /api/orgs/:orgId/events/:eventId/budget`
Преглед на активния бюджет.

**Права (служители)**: Пълен изглед с разходи по доставчици и маржове.
**Права (клиент с `can_view_budget = true`)**: Филтриран изглед — без `supplier_cost_cents` и `margin_cents`.
**Права (клиент с `can_view_budget = false`)**: `403 FORBIDDEN`.

**Отговор `200 OK` (клиентски изглед):**
```json
{
  "budgetVersionId": "bv-wedding-v2",
  "versionNumber": 2,
  "state": "active",
  "totalAmountCents": 530000,
  "totalAmountFormatted": "5 300,00 €",
  "lineItems": [
    {
      "id": "bi-venue",
      "category": "Локация",
      "label": "Наем на Резиденция Тера",
      "clientAmountCents": 200000
    }
  ]
}
```

---

### `POST /api/orgs/:orgId/events/:eventId/budget/propose`
Предлагане на нова бюджетна версия.

**Права**: `manager`, `owner`.

**Заявка:**
```json
{
  "items": [
    { "category": "Локация", "label": "Наем на зала", "clientAmountCents": 200000, "supplierCostCents": 150000 },
    { "category": "Допълнителни", "label": "Авторски коктейлен бар", "clientAmountCents": 30000, "supplierCostCents": 22000 }
  ]
}
```

**Отговор `201 Created`:**
```json
{
  "budgetVersionId": "bv-wedding-v3",
  "versionNumber": 3,
  "proposedAt": "2026-10-12T11:00:00.000Z"
}
```

---

### `POST /api/orgs/:orgId/events/:eventId/payments`
Записване на реално постъпило плащане.

**Права**: `manager`, `owner`.

**Заявка:**
```json
{
  "scheduleEntryId": "ps-wedding-deposit",
  "amountCents": 200000,
  "referenceLabel": "Банков превод BG98UNCR70001",
  "paidAt": "2026-09-28T09:00:00.000Z"
}
```

**Отговор `201 Created`:**
```json
{
  "paymentEntryId": "pe-wedding-deposit-01",
  "amountCents": 200000,
  "cumulativePaidCents": 200000
}
```

---

### `POST /api/orgs/:orgId/events/:eventId/payments/:paymentEntryId/reverse`
Сторно (корекция) на грешен запис.

**Права**: `owner`.

**Заявка:**
```json
{
  "amountCents": 20000,
  "reasonLabel": "Надплатена такса за сомелиер"
}
```

**Отговор `201 Created`:**
```json
{
  "reversalEntryId": "pe-reversal-01",
  "amountCents": -20000,
  "netCumulativePaidCents": 180000
}
```

**Грешки:**
- `422 BUSINESS_RULE_VIOLATION` — сторно надвишава сумата на оригиналния запис.
- `422 BUSINESS_RULE_VIOLATION` — опит за сторниране на запис, който вече е сторниран (anti-chain).

---

## 6. Документи (Documents)

### `POST /api/orgs/:orgId/events/:eventId/documents`
Качване на документ.

**Права**: `coordinator`, `manager`, `owner`.

**Ограничения:**
- Максимален размер: **20 MiB (20 971 520 байта)**
- Позволени MIME типове: `application/pdf`, `image/jpeg`, `image/png`

**Заявка** (`multipart/form-data`):
```
file: <binary>
audience: "client" | "team"
label: "Договор с локацията"
```

**Отговор `201 Created`:**
```json
{
  "documentId": "doc-contract-01",
  "scanState": "quarantined",
  "message": "Файлът е качен и е в опашка за антивирусно сканиране."
}
```

---

### `GET /api/orgs/:orgId/events/:eventId/documents`
Списък с достъпни документи.

**Права (клиент)**: Само документи с `audience = 'client'` и `scan_state = 'ready'`.
**Права (клиент, `can_view_budget = false`)**: Без финансови документи (`document_type = 'financial'`).

**Отговор `200 OK`:**
```json
{
  "documents": [
    {
      "id": "doc-contract-01",
      "label": "Договор с локацията",
      "documentType": "contract",
      "scanState": "ready",
      "fileSizeBytes": 524288,
      "uploadedAt": "2026-10-12T10:00:00.000Z"
    }
  ]
}
```

---

### `GET /api/orgs/:orgId/documents/:documentId/download`
Генериране на временен URL за изтегляне.

**Права**: Проверка на активна сесия + активно членство в събитието, към което принадлежи документът.

**Отговор `200 OK`:**
```json
{
  "downloadUrl": "https://storage.sazaevents.com/documents/doc-contract-01?token=tmp-xyz&expires=1728743999",
  "expiresAt": "2026-10-12T15:00:00.000Z"
}
```

**Грешки:**
- `403 FORBIDDEN` — достъпът е отнет или `can_view_budget = false` за финансов документ.
- `404 NOT_FOUND` — документът не съществува, е изтрит или принадлежи на друга организация.
- `422 BUSINESS_RULE_VIOLATION` — документът е в статус `quarantined` или `rejected`.

---

## 7. Комуникация (Threads & Comments)

### `GET /api/orgs/:orgId/events/:eventId/threads`
Списък с разговори по събитието.

**Права (клиент)**: Само публични нишки (`visibility = 'client'`). Вътрешните нишки са **невидими** — не се включват в отговора, дори в скрит вид.

**Отговор `200 OK`:**
```json
{
  "threads": [
    {
      "id": "thread-catering-01",
      "subject": "Потвърждение на финалното меню",
      "visibility": "client",
      "lastCommentAt": "2026-10-12T09:15:00.000Z",
      "commentCount": 2
    }
  ]
}
```

---

### `POST /api/orgs/:orgId/threads/:threadId/comments`
Добавяне на нов коментар.

**Права**: Активно членство в нишката (клиент или служител).

**Заявка:**
```json
{
  "textMd": "Здравейте Елена, качихме **обновените варианти** за 4-степенното меню.",
  "isInternalNote": false
}
```

**Отговор `201 Created`:**
```json
{
  "commentId": "comm-a1b2c3",
  "sanitizedText": "Здравейте Елена, качихме обновените варианти за 4-степенното меню.",
  "createdAt": "2026-10-12T09:00:00.000Z"
}
```

> [!NOTE]
> Полето `isInternalNote = true` е достъпно **само за служители**. При подаване от клиент параметърът се игнорира и коментарът се записва като публичен.
>
> Текстът се санира при съхранение: потенциално опасни HTML тагове и скриптове се премахват (доказано в тест `T38`).

---

## 8. Матрица на правата по ендпойнт

| Ендпойнт | owner | manager | coordinator | client_decision_maker | client_viewer |
|---|:---:|:---:|:---:|:---:|:---:|
| `POST /events` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `GET /events/:id/overview` | ✅ | ✅ | ✅ | ✅ | ✅ |
| `POST /invitations` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `DELETE /memberships/:id` | ✅ | ❌ | ❌ | ❌ | ❌ |
| `POST /milestones` | ✅ | ✅ | ✅ | ❌ | ❌ |
| `POST /milestones/:id/publish` | ✅ | ✅ | ✅ | ❌ | ❌ |
| `POST /approvals/:id/respond` | ❌ | ❌ | ❌ | ✅ | ❌ |
| `GET /budget` (пълен) | ✅ | ✅ | ✅ | ❌ | ❌ |
| `GET /budget` (клиентски) | ✅ | ✅ | ✅ | ✅ (`can_view_budget`) | ❌ |
| `POST /budget/propose` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `POST /payments` | ✅ | ✅ | ❌ | ❌ | ❌ |
| `POST /payments/:id/reverse` | ✅ | ❌ | ❌ | ❌ | ❌ |
| `GET /documents` (клиентски) | ✅ | ✅ | ✅ | ✅ | ✅ (без финансови) |
| `POST /documents` | ✅ | ✅ | ✅ | ❌ | ❌ |
| `GET /documents/:id/download` | ✅ | ✅ | ✅ | ✅ | ✅ (без финансови) |
| `GET /threads` (вътрешни) | ✅ | ✅ | ✅ | ❌ | ❌ |
| `GET /threads` (публични) | ✅ | ✅ | ✅ | ✅ | ✅ |
| `POST /threads/:id/comments` | ✅ | ✅ | ✅ | ✅ | ✅ |
