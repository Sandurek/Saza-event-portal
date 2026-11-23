// public/app.js - Saza Event Portal
// Интерактивен портал за организатори (Sando) и клиенти (само за взимане на решения и проследяване)

(function () {
  'use strict';

  const state = {
    user: null, // Sando / ZMoskov / Manager / Coordinator (staff) или null
    clientAccess: null, // данни за събитието, заредени през клиентски токен
    clientToken: null,
    events: [],
    currentEventId: null,
    currentEventDetails: null,
    currentView: 'events', // 'events' | 'event-detail' | 'finances' | 'dashboard' | 'users'
    activeTab: 'overview', // 'overview' | 'milestones' | 'proposals' | 'documents' | 'finances'
    financesData: null,
    users: [],
    clients: [],
    userSearch: '',
    eventSearch: '',
    eventTypeFilter: 'all',
    userModal: null, // null | { mode: 'create' } | { mode: 'edit', userId: string }
    _lastRouteKey: null,
    _lastModalKey: null,
    _closingModalTimer: null,
    isSidebarOpen: false,
    isNewEventModalOpen: false,
    isNewMilestoneModalOpen: false,
    isNewProposalModalOpen: false,
    isNewPaymentModalOpen: false,
    isNewBudgetItemModalOpen: false,
    isNewScheduleModalOpen: false,
    selectedEventForModal: null,
    selectedOptionId: null,
    decisionComment: '',
  };

  // ─── Помощни функции ────────────────────────────────────────────────────────

  function showToast(message, type = 'success') {
    const container = document.getElementById('toast-container');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    toast.innerHTML = `<span>${type === 'success' ? '✅' : '⚠️'}</span> <span>${escapeHtml(message)}</span>`;
    container.appendChild(toast);
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
      toast.style.transition = 'all 0.3s ease';
      setTimeout(() => toast.remove(), 300);
    }, 3500);
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function formatEUR(cents) {
    if (cents === null || cents === undefined) return 'По договаряне';
    const euros = (cents / 100).toFixed(2);
    const parts = euros.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
    return `${parts.join(',')} €`;
  }

  function formatDate(isoStr) {
    if (!isoStr) return '';
    try {
      const d = new Date(isoStr);
      return d.toLocaleDateString('bg-BG', { day: 'numeric', month: 'long', year: 'numeric' });
    } catch {
      return isoStr;
    }
  }

  // ─── API Клиент ──────────────────────────────────────────────────────────────

  async function apiFetch(endpoint, options = {}) {
    options.headers = options.headers || {};
    if (state.clientToken) {
      options.headers['X-Client-Token'] = state.clientToken;
    }
    const res = await fetch(endpoint, options);
    const contentType = res.headers.get('content-type') || '';
    let data = {};
    if (contentType.includes('application/json')) {
      data = await res.json();
    }
    if (!res.ok) {
      throw new Error(data.error?.message || `Сървърна грешка (${res.status})`);
    }
    return data;
  }

  // ─── Инициализация ──────────────────────────────────────────────────────────

  async function init() {
    const urlParams = new URLSearchParams(window.location.search);
    const token = urlParams.get('token');

    if (token) {
      // Клиентски режим през споделен линк
      state.clientToken = token;
      try {
        const accessData = await apiFetch(`/api/portal/access?token=${encodeURIComponent(token)}`);
        state.clientAccess = accessData;
        render();
        return;
      } catch (err) {
        showToast(err.message, 'error');
        renderClientError(err.message);
        return;
      }
    }

    // Проверка за активна сесия на организатор
    try {
      const session = await apiFetch('/api/auth/session');
      if (session.authenticated && (session.user?.isStaff || session.user?.role === 'owner')) {
        state.user = session.user;
        await loadStaffEvents();
        await loadFinancesOverview();
        await loadUsers();
      }
    } catch {
      state.user = null;
    }

    render();
  }

  async function loadStaffEvents() {
    try {
      const res = await apiFetch('/api/events');
      state.events = res.events || [];
      if (state.events.length === 0) {
        state.currentEventId = null;
        state.currentEventDetails = null;
      } else {
        const stillExists = state.events.some(ev => ev.id === state.currentEventId);
        if (!state.currentEventId || !stillExists) {
          state.currentEventId = state.events[0].id;
        }
        if (state.currentEventId) {
          await loadEventDetails(state.currentEventId);
        }
      }
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  async function loadEventDetails(eventId) {
    try {
      const res = await apiFetch(`/api/events/${eventId}`);
      const milestonesRes = await apiFetch(`/api/events/${eventId}/milestones`);
      const proposalsRes = await apiFetch(`/api/events/${eventId}/proposals`);
      const docsRes = await apiFetch(`/api/events/${eventId}/documents`);
      let budgetData = null;
      try {
        budgetData = await apiFetch(`/api/events/${eventId}/budget`);
      } catch {}

      state.currentEventDetails = {
        ...res.event,
        milestones: milestonesRes.milestones || [],
        proposals: proposalsRes.proposals || [],
        documents: docsRes.documents || [],
        budget: budgetData?.budget || null,
        payments: budgetData?.payments || null,
        internalItems: budgetData?.internalItems || [],
      };
    } catch (err) {
      showToast(err.message, 'error');
    }
  }

  async function loadFinancesOverview() {
    try {
      const res = await apiFetch('/api/finances/overview');
      state.financesData = res;
    } catch (err) {
      console.warn('Finances overview error:', err);
    }
  }

  async function loadUsers() {
    if (!state.user) return;
    try {
      if (state.user.role === 'owner') {
        const res = await apiFetch('/api/admin/users');
        state.users = res.users || [];
        state.clients = res.clients || [];
      } else {
        const res = await apiFetch('/api/team');
        state.users = res.users || [];
        state.clients = [];
      }
    } catch (err) {
      console.warn('Users load error:', err);
    }
  }

  function getRoleLabel(role) {
    if (role === 'owner') return '👑 Собственик (Owner)';
    if (role === 'manager') return '💼 Мениджър (Manager)';
    if (role === 'coordinator') return '📋 Координатор (Coordinator)';
    return escapeHtml(role || 'Екип');
  }

  function isOwner() {
    return state.user?.role === 'owner';
  }

  function canManageAgencyFinances() {
    return state.user?.role === 'owner' || state.user?.role === 'manager';
  }

  function getEventTypeLabel(type) {
    const map = {
      wedding: 'Сватба',
      corporate: 'Корпоративно',
      personal: 'Лично събитие',
      other: 'Друго',
    };
    return map[type] || type || 'Събитие';
  }

  function preserveInputFocus(inputId, updater) {
    const activeInput = document.getElementById(inputId);
    const value = activeInput?.value ?? '';
    const start = activeInput?.selectionStart ?? value.length;
    const end = activeInput?.selectionEnd ?? value.length;
    updater();
    render();
    const restored = document.getElementById(inputId);
    if (restored) {
      restored.focus();
      try {
        restored.setSelectionRange(start, end);
      } catch {}
    }
  }

  // ─── Рендиране ──────────────────────────────────────────────────────────────

  function getCurrentRouteKey() {
    if (state.clientAccess) return 'client';
    if (!state.user) return 'login';
    if (state.currentView === 'event-detail') {
      return `staff:event-detail:${state.currentEventId || ''}:${state.activeTab}`;
    }
    return `staff:${state.currentView}`;
  }

  function getActiveModalKey() {
    if (state.isNewEventModalOpen) return 'new-event';
    if (state.isNewMilestoneModalOpen) return 'new-milestone';
    if (state.isNewProposalModalOpen) return 'new-proposal';
    if (state.isNewPaymentModalOpen) return `new-payment:${state.selectedEventForModal || ''}`;
    if (state.isNewBudgetItemModalOpen) return `new-budget:${state.selectedEventForModal || ''}`;
    if (state.isNewScheduleModalOpen) return `new-schedule:${state.selectedEventForModal || ''}`;
    if (state.userModal) return `user:${state.userModal.mode}:${state.userModal.user?.userId || ''}:${!!state.userModal.forceActivate}`;
    return 'none';
  }

  function resetModalFlags() {
    if (state._closingModalTimer) {
      clearTimeout(state._closingModalTimer);
      state._closingModalTimer = null;
    }
    state.isNewEventModalOpen = false;
    state.isNewMilestoneModalOpen = false;
    state.isNewProposalModalOpen = false;
    state.isNewPaymentModalOpen = false;
    state.isNewBudgetItemModalOpen = false;
    state.isNewScheduleModalOpen = false;
    state.userModal = null;
  }

  function openModalWith(setter) {
    resetModalFlags();
    setter();
    render();
  }

  function renderActiveModal() {
    if (state.isNewEventModalOpen) return renderNewEventModal();
    if (state.isNewMilestoneModalOpen) return renderNewMilestoneModal();
    if (state.isNewProposalModalOpen) return renderNewProposalModal();
    if (state.isNewPaymentModalOpen) return renderNewPaymentModal();
    if (state.isNewBudgetItemModalOpen) return renderNewBudgetItemModal();
    if (state.isNewScheduleModalOpen) return renderNewScheduleModal();
    if (state.userModal) return renderUserModal();
    return '';
  }

  function render() {
    const root = document.getElementById('app-root');
    if (!root) return;

    const routeKey = getCurrentRouteKey();
    const modalKey = getActiveModalKey();
    const routeChanged = routeKey !== state._lastRouteKey;
    const modalChanged = modalKey !== state._lastModalKey;

    // 1. Клиентски портал (през споделен линк)
    if (state.clientAccess) {
      state._lastRouteKey = routeKey;
      state._lastModalKey = 'none';
      root.innerHTML = renderClientPortal();
      return;
    }

    // 2. Вход за Sando (ако не е логнат)
    if (!state.user) {
      state._lastRouteKey = routeKey;
      state._lastModalKey = 'none';
      root.innerHTML = renderLoginScreen();
      return;
    }

    // 3. Работно пространство (частично обновяване в браузъра, за да не примигва страничното меню)
    const events = state.events;
    const currentEvent = state.currentEventDetails;
    const sidebarEl = document.getElementById('sidebar');
    const overlayEl = document.getElementById('sidebar-overlay');
    const titleEl = document.getElementById('agency-topbar-title');
    const actionsEl = document.getElementById('agency-topbar-actions');
    const contentEl = document.getElementById('agency-content-area');
    const modalEl = document.getElementById('agency-modal-root');

    if (sidebarEl && titleEl && actionsEl && contentEl && modalEl) {
      const prevScrollTop = sidebarEl.scrollTop || 0;
      sidebarEl.className = `agency-sidebar ${state.isSidebarOpen ? 'open' : ''}`;
      sidebarEl.innerHTML = renderAgencySidebarInner(events, currentEvent);
      sidebarEl.scrollTop = prevScrollTop;

      if (overlayEl) {
        overlayEl.className = `agency-sidebar-overlay ${state.isSidebarOpen ? 'open' : ''}`;
      }

      if (routeChanged) {
        titleEl.innerHTML = `<button class="sidebar-mobile-toggle" onclick="window.app.toggleSidebar()" title="Меню">☰</button>${renderHeaderTitle(currentEvent)}`;
        actionsEl.innerHTML = renderHeaderActions(currentEvent);
        contentEl.innerHTML = `<div class="view-stage view-enter">${renderMainContent(events, currentEvent)}</div>`;
      } else {
        actionsEl.innerHTML = renderHeaderActions(currentEvent);
        contentEl.innerHTML = `<div class="view-stage">${renderMainContent(events, currentEvent)}</div>`;
      }

      if (modalChanged) {
        modalEl.innerHTML = renderActiveModal();
      }

      state._lastRouteKey = routeKey;
      state._lastModalKey = modalKey;
      return;
    }

    state._lastRouteKey = routeKey;
    state._lastModalKey = modalKey;
    root.innerHTML = renderStaffWorkspace(routeChanged);
  }

  function renderClientError(msg) {
    const root = document.getElementById('app-root');
    if (!root) return;
    root.innerHTML = `
      <div class="login-wrapper">
        <div class="login-card" style="text-align: center;">
          <div style="font-size: 48px; margin-bottom: 16px;">🔒</div>
          <h2 style="font-size: 20px; font-weight: 700; margin-bottom: 8px;">Невалиден или изтекъл линк</h2>
          <p style="color: #94a3b8; font-size: 14px; margin-bottom: 20px;">${escapeHtml(msg || 'Връзката за събитието не е намерена или е била деактивирана.')}</p>
          <a href="/" class="btn btn-secondary" style="display: inline-block; padding: 10px 20px; text-decoration: none;">Към началната страница</a>
        </div>
      </div>
    `;
  }

  // ─── 1. Login Screen ────────────────────────────────────────────────────────

  function renderLoginScreen() {
    return `
      <div class="login-wrapper">
        <div class="login-card">
          <div class="login-brand">
            <div class="login-logo-circle">
              <span class="login-logo-text">SaZa</span>
            </div>
            <h1>SaZa Event Portal</h1>
            <p>Вход за организатори на събития</p>
          </div>

          <form class="login-form" onsubmit="window.app.handleLogin(event)">
            <div id="login-error-msg" class="login-error" style="display: none;"></div>

            <div class="form-group">
              <label for="username">Потребителско име</label>
              <input type="text" id="username" class="form-control" value="Sando" required autocomplete="username" />
            </div>

            <div class="form-group">
              <label for="password">Парола</label>
              <input type="password" id="password" class="form-control" placeholder="Въведете парола" required autocomplete="current-password" autofocus />
            </div>

            <button type="submit" id="login-submit-btn" class="login-btn">
              Влез в системата
            </button>
          </form>
        </div>
      </div>
    `;
  }

  // ─── 2. Staff Workspace (Sando) ─────────────────────────────────────────────

  function renderStaffWorkspace(animateView = false) {
    const events = state.events;
    const currentEvent = state.currentEventDetails;

    return `
      <div class="agency-layout">
        <div id="sidebar-overlay"
             class="agency-sidebar-overlay ${state.isSidebarOpen ? "open" : ""}"
             onclick="window.app.toggleSidebar()"></div>

        <aside id="sidebar" class="agency-sidebar ${state.isSidebarOpen ? "open" : ""}">
          ${renderAgencySidebarInner(events, currentEvent)}
        </aside>

        <main class="agency-main">
          <header class="agency-topbar-header">
            <div id="agency-topbar-title" class="agency-topbar-title">
              <button class="sidebar-mobile-toggle" onclick="window.app.toggleSidebar()" title="Меню">☰</button>
              ${renderHeaderTitle(currentEvent)}
            </div>
            <div id="agency-topbar-actions" class="agency-topbar-actions">
              ${renderHeaderActions(currentEvent)}
            </div>
          </header>

          <div id="agency-content-area" class="agency-content-area">
            <div class="view-stage ${animateView ? "view-enter" : ""}">
              ${renderMainContent(events, currentEvent)}
            </div>
          </div>
        </main>
      </div>

      <div id="agency-modal-root">${renderActiveModal()}</div>
    `;
  }

  function renderAgencySidebarInner(events, currentEvent) {
    const user = state.user || {};
    const initials = (user.displayName || "S").slice(0, 2).toUpperCase();
    const roleLabel = getRoleLabel(user.role);
    const canCreateEvents = canManageAgencyFinances();
    const totalProfilesCount = (state.users?.length || 0) + (isOwner() ? (state.clients?.length || 0) : 0);
    const isDetailView = state.currentView === "event-detail";

    return `
        <div class="agency-sidebar-brand">
          <div class="logo-circle">SaZa</div>
          <div class="brand-text">
            <span class="brand-name">SaZa Event</span>
            <span class="brand-sub">Агенция за събития</span>
          </div>
        </div>

        <div class="agency-sidebar-user">
          <div class="user-avatar">${escapeHtml(initials)}</div>
          <div class="user-info">
            <span class="user-name">${escapeHtml(user.displayName || "Служител")}</span>
            <span class="user-role">${escapeHtml(roleLabel)}</span>
          </div>
        </div>

        <div class="agency-nav-group">
          <div class="agency-nav-title">Главно меню</div>
          <nav class="agency-nav-list">
            <button class="agency-nav-item ${state.currentView === "dashboard" ? "active" : ""}"
                    onclick="window.app.switchView('dashboard')">
              <span class="nav-left">
                <span class="nav-icon">📊</span>
                <span>Табло (Dashboard)</span>
              </span>
            </button>

            <button class="agency-nav-item ${state.currentView === "events" ? "active" : ""}"
                    onclick="window.app.switchView('events')">
              <span class="nav-left">
                <span class="nav-icon">📅</span>
                <span>Всички събития</span>
              </span>
              <span class="nav-counter-pill">${events.length}</span>
            </button>

            <button class="agency-nav-item ${state.currentView === "finances" ? "active" : ""}"
                    onclick="window.app.switchView('finances')">
              <span class="nav-left">
                <span class="nav-icon">💰</span>
                <span>Финанси на агенцията</span>
              </span>
            </button>

            <button class="agency-nav-item ${state.currentView === "users" ? "active" : ""}"
                    onclick="window.app.switchView('users')">
              <span class="nav-left">
                <span class="nav-icon">👥</span>
                <span>Хора и Профили</span>
              </span>
              ${totalProfilesCount > 0 ? `<span class="nav-counter-pill">${totalProfilesCount}</span>` : ""}
            </button>
          </nav>
        </div>

        ${currentEvent && events.length > 0 ? `
          <div class="agency-nav-group">
            <div class="agency-nav-title">Активно събитие</div>
            <div style="margin-bottom: 8px; padding: 0 4px;">
              <select class="form-control" style="font-size: 13px; font-weight: 600; padding: 6px 10px; background: rgba(255,255,255,0.12); color: #ffffff; border: 1px solid rgba(255,255,255,0.22); border-radius: 6px; cursor: pointer; width: 100%;"
                      onchange="window.app.switchEvent(this.value)">
                ${events.map(ev => `
                  <option value="${ev.id}" ${ev.id === state.currentEventId ? "selected" : ""} style="color: #0f172a; background: #ffffff;">
                    ${escapeHtml(ev.title)}
                  </option>
                `).join("")}
              </select>
            </div>

            <nav class="agency-nav-list">
              <button class="agency-nav-item ${isDetailView && state.activeTab === "overview" ? "active" : ""}"
                      onclick="window.app.switchEventTab('overview')">
                <span class="nav-left">
                  <span class="nav-icon">📌</span>
                  <span>Общ преглед</span>
                </span>
              </button>

              <button class="agency-nav-item ${isDetailView && state.activeTab === "milestones" ? "active" : ""}"
                      onclick="window.app.switchEventTab('milestones')">
                <span class="nav-left">
                  <span class="nav-icon">📋</span>
                  <span>Етапи и Срокове</span>
                </span>
                <span class="nav-counter-pill">${currentEvent.milestones?.length || 0}</span>
              </button>

              <button class="agency-nav-item ${isDetailView && state.activeTab === "proposals" ? "active" : ""}"
                      onclick="window.app.switchEventTab('proposals')">
                <span class="nav-left">
                  <span class="nav-icon">⚡</span>
                  <span>Оферти за избор</span>
                </span>
                <span class="nav-counter-pill">${currentEvent.proposals?.length || 0}</span>
              </button>

              <button class="agency-nav-item ${isDetailView && state.activeTab === "documents" ? "active" : ""}"
                      onclick="window.app.switchEventTab('documents')">
                <span class="nav-left">
                  <span class="nav-icon">📁</span>
                  <span>Документи</span>
                </span>
                <span class="nav-counter-pill">${currentEvent.documents?.length || 0}</span>
              </button>

              <button class="agency-nav-item ${isDetailView && state.activeTab === "finances" ? "active" : ""}"
                      onclick="window.app.switchEventTab('finances')">
                <span class="nav-left">
                  <span class="nav-icon">💳</span>
                  <span>Бюджет & Плащания</span>
                </span>
              </button>
            </nav>
          </div>
        ` : ""}

        <div class="agency-sidebar-footer">
          ${canCreateEvents ? `
            <button class="btn-new-event" onclick="window.app.openNewEventModal()">
              <span>➕</span> Ново събитие
            </button>
          ` : ""}
          <button class="btn-sidebar-logout" onclick="window.app.handleLogout()">
            <span>🚪</span> Изход от профила
          </button>
        </div>
    `;
  }

  function renderHeaderTitle(currentEvent) {
    if (state.currentView === "users") {
      return `<h1>👥 Хора, Профили и Роли</h1>`;
    }
    if (state.currentView === "finances") {
      return `<h1>💰 Финанси & Бюджети на агенцията</h1>`;
    }
    if (state.currentView === "dashboard") {
      return `<h1>📊 Табло за управление на агенцията</h1>`;
    }
    if (state.currentView === "event-detail" && currentEvent) {
      return `
        <button class="btn btn-secondary btn-sm" onclick="window.app.switchView('events')">← Списък</button>
        <h1>📅 ${escapeHtml(currentEvent.title)}</h1>
      `;
    }
    return `<h1>📅 Списък със събитията (${(state.events || []).length})</h1>`;
  }

  function renderHeaderActions(currentEvent) {
    const canCreateEvents = canManageAgencyFinances();
    if (state.currentView === "users") {
      return `
        <button class="btn btn-secondary btn-sm" onclick="window.app.refreshUsers()">🔄 Обнови списъка</button>
        ${isOwner() ? `
          <button class="btn btn-primary btn-sm" onclick="window.app.openNewUserModal()">➕ Добави нов профил</button>
        ` : ""}
      `;
    }
    if (state.currentView === "finances") {
      return `
        <button class="btn btn-secondary btn-sm" onclick="window.app.refreshFinances()">🔄 Обнови данни</button>
        ${canCreateEvents ? `
          <button class="btn btn-primary btn-sm" onclick="window.app.openNewPaymentModal()">➕ Запиши плащане</button>
          <button class="btn btn-secondary btn-sm" onclick="window.app.openNewBudgetItemModal()">➕ Ново перо</button>
        ` : ""}
      `;
    }
    if (state.currentView === "dashboard") {
      return `
        <button class="btn btn-secondary btn-sm" onclick="window.app.switchView('events')">📋 Всички събития</button>
        ${canCreateEvents ? `<button class="btn btn-primary btn-sm" onclick="window.app.openNewEventModal()">➕ Ново събитие</button>` : ""}
        <button class="btn btn-secondary btn-sm" onclick="window.app.switchView('finances')">💰 Финанси</button>
      `;
    }
    if (state.currentView === "event-detail" && currentEvent) {
      const clientLink = currentEvent.clientToken
        ? `${window.location.origin}/?token=${currentEvent.clientToken}`
        : (currentEvent.clientLink || "");
      return `
        ${clientLink ? `
          <button class="btn-copy-link" onclick="window.app.copyClientLink('${escapeHtml(clientLink)}')">
            🔗 Линк за клиента
          </button>
          <button class="btn btn-secondary btn-sm" onclick="window.open('${escapeHtml(clientLink)}', '_blank')">
            👁️ Отвори като клиент
          </button>
        ` : ""}
        ${canCreateEvents ? `<button class="btn btn-primary btn-sm" onclick="window.app.openNewEventModal()">➕ Ново събитие</button>` : ""}
        ${isOwner() ? `
          <button class="btn btn-danger btn-sm" onclick="window.app.handleDeleteEvent('${escapeHtml(currentEvent.id)}')">
            🗑️ Изтрий събитието
          </button>
        ` : ""}
      `;
    }
    return `
      <button class="btn btn-secondary btn-sm" onclick="window.app.refreshEvents()">🔄 Обнови списъка</button>
      ${canCreateEvents ? `<button class="btn btn-primary btn-sm" onclick="window.app.openNewEventModal()">➕ Ново събитие</button>` : ""}
    `;
  }

  function renderMainContent(events, currentEvent) {
    if (state.currentView === "users") {
      return renderAgencyUsersView();
    }
    if (state.currentView === "finances") {
      return renderAgencyFinancesView();
    }
    if (state.currentView === "dashboard") {
      return renderAgencyDashboardView(events);
    }
    if (!events || events.length === 0) {
      return renderEmptyEventsState();
    }
    if (state.currentView === "event-detail") {
      return renderEventsView(events, currentEvent);
    }
    return renderEventsListView(events);
  }

  function renderEventsListView(events) {
    const q = (state.eventSearch || "").trim().toLowerCase();
    const typeFilter = state.eventTypeFilter || "all";
    const ownerUser = isOwner();
    const canCreateEvents = canManageAgencyFinances();

    const filteredEvents = events.filter(ev => {
      if (typeFilter !== "all" && (ev.event_type || "wedding") !== typeFilter) return false;
      if (!q) return true;
      return [ev.title, ev.venue_label, ev.client_name, ev.client_email, ev.event_type]
        .some(v => String(v || "").toLowerCase().includes(q));
    });

    const totalBudgetCents = events.reduce((sum, ev) => sum + Number(ev.budget_cents || 0), 0);
    const totalPaidCents = events.reduce((sum, ev) => sum + Number(ev.paid_cents || 0), 0);
    const weddingsCount = events.filter(ev => ev.event_type === "wedding").length;

    return `
      <div style="margin-bottom: 24px; display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap;">
        <div>
          <h2 style="font-size: 22px; font-weight: 800; color: #0f172a; margin: 0 0 6px 0;">
            📅 Списък със събитията
          </h2>
          <p style="font-size: 14px; color: #64748b; margin: 0;">
            ${ownerUser
              ? 'Пълен преглед на всички събития в агенцията. Като Собственик имате пълни права — включително управление и изтриване на събития.'
              : 'Списък на събитията с бърз достъп до детайли, етапи, оферти, документи и финанси.'}
          </p>
        </div>
        ${canCreateEvents ? `
          <button class="btn btn-primary" onclick="window.app.openNewEventModal()">
            ➕ Ново събитие
          </button>
        ` : ""}
      </div>

      <div class="finance-kpi-grid">
        <div class="finance-kpi-card kpi-turnover">
          <div class="finance-kpi-label">📅 Общо събития</div>
          <div class="finance-kpi-value">${events.length}</div>
          <div class="finance-kpi-sub">${weddingsCount} сватби • ${events.length - weddingsCount} други</div>
        </div>

        <div class="finance-kpi-card kpi-collected">
          <div class="finance-kpi-label">📋 Договорени бюджети</div>
          <div class="finance-kpi-value">${escapeHtml(formatEUR(totalBudgetCents))}</div>
          <div class="finance-kpi-sub">Обща стойност по активни бюджети</div>
        </div>

        <div class="finance-kpi-card kpi-margin">
          <div class="finance-kpi-label">💳 Постъпили плащания</div>
          <div class="finance-kpi-value" style="color: #1e4d2b;">${escapeHtml(formatEUR(totalPaidCents))}</div>
          <div class="finance-kpi-sub">Събрани суми от клиенти</div>
        </div>

        <div class="finance-kpi-card kpi-pending">
          <div class="finance-kpi-label">🔍 Показани в списъка</div>
          <div class="finance-kpi-value" style="color: #0e7490;">${filteredEvents.length}</div>
          <div class="finance-kpi-sub">${q || typeFilter !== "all" ? "По зададения филтър" : "Всички налични събития"}</div>
        </div>
      </div>

      <div class="card" style="padding: 16px 20px; margin-bottom: 20px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap;">
        <div style="flex: 2; min-width: 220px;">
          <input id="events-search-input"
                 type="search"
                 class="form-control"
                 placeholder="🔎 Търси по име на събитие, клиент, имейл или локация..."
                 value="${escapeHtml(state.eventSearch || "")}"
                 oninput="window.app.setEventSearch(this.value)" />
        </div>
        <div style="min-width: 190px;">
          <select class="form-control" aria-label="Филтър по тип събитие"
                  onchange="window.app.setEventTypeFilter(this.value)">
            <option value="all" ${typeFilter === "all" ? "selected" : ""}>Всички типове</option>
            <option value="wedding" ${typeFilter === "wedding" ? "selected" : ""}>💒 Сватби</option>
            <option value="corporate" ${typeFilter === "corporate" ? "selected" : ""}>🏢 Корпоративни</option>
            <option value="personal" ${typeFilter === "personal" ? "selected" : ""}>🎉 Лични събития</option>
            <option value="other" ${typeFilter === "other" ? "selected" : ""}>✨ Други</option>
          </select>
        </div>
        ${(state.eventSearch || typeFilter !== "all") ? `
          <button class="btn btn-secondary btn-sm" onclick="window.app.setEventSearch(''); window.app.setEventTypeFilter('all');">
            ✕ Изчисти
          </button>
        ` : ""}
      </div>

      <div class="finance-table-card">
        <div class="card-header">
          <h3 style="font-size: 16px; font-weight: 700; color: #1e293b; margin: 0;">
            📋 Събития (${filteredEvents.length})
          </h3>
          <span style="font-size: 12px; color: #64748b;">Кликнете върху събитие за отваряне на пълното работно пространство</span>
        </div>
        <div class="finance-table-wrapper">
          <table class="finance-table">
            <thead>
              <tr>
                <th>Събитие</th>
                <th>Дата & Локация</th>
                <th>Клиент & Портал</th>
                <th>Бюджет / Платено</th>
                <th>Етапи & Оферти</th>
                <th style="text-align: right;">Действия</th>
              </tr>
            </thead>
            <tbody>
              ${filteredEvents.length === 0 ? `
                <tr>
                  <td colspan="6" style="text-align: center; padding: 30px; color: #64748b;">
                    Няма намерени събития по зададения филтър.
                  </td>
                </tr>
              ` : filteredEvents.map(ev => {
                const clientLink = ev.client_token ? `${window.location.origin}/?token=${ev.client_token}` : "";
                const evType = ev.event_type || "wedding";
                return `
                  <tr>
                    <td>
                      <button type="button"
                              onclick="window.app.switchEvent('${escapeHtml(ev.id)}')"
                              style="background: none; border: none; padding: 0; text-align: left; cursor: pointer; font-weight: 800; font-size: 15px; color: #0f172a;">
                        ${escapeHtml(ev.title)}
                      </button>
                      <div style="margin-top: 4px; display: flex; gap: 6px; align-items: center; flex-wrap: wrap;">
                        <span class="status-pill status-${escapeHtml(evType)}">${escapeHtml(getEventTypeLabel(evType))}</span>
                        <span class="status-pill status-${escapeHtml(ev.lifecycle || 'planning')}">${escapeHtml(ev.lifecycle || 'planning')}</span>
                      </div>
                    </td>
                    <td>
                      <div style="font-weight: 600; color: #1e293b;">📅 ${formatDate(ev.starts_at)}</div>
                      <div style="font-size: 12px; color: #64748b; margin-top: 2px;">${ev.venue_label ? `📍 ${escapeHtml(ev.venue_label)}` : "—"}</div>
                    </td>
                    <td>
                      <div style="font-weight: 600; color: #1e293b;">${escapeHtml(ev.client_name || "Клиент")}</div>
                      <div style="font-size: 12px; color: #64748b;">${escapeHtml(ev.client_email || "—")}</div>
                      ${clientLink ? `
                        <button class="btn btn-secondary btn-sm" style="margin-top: 4px; padding: 2px 8px; min-height: 26px; font-size: 11px;"
                                onclick="window.app.copyClientLink('${escapeHtml(clientLink)}')">
                          🔗 Копирай линк
                        </button>
                      ` : ""}
                    </td>
                    <td>
                      <div style="font-weight: 700; color: #0f172a;">${escapeHtml(formatEUR(Number(ev.budget_cents || 0)))}</div>
                      <div style="font-size: 12px; color: #1e4d2b; margin-top: 2px;">Платено: ${escapeHtml(formatEUR(Number(ev.paid_cents || 0)))}</div>
                    </td>
                    <td style="font-size: 13px; color: #475569;">
                      <div>📋 ${Number(ev.milestones_count || 0)} етапа</div>
                      <div style="margin-top: 2px;">⚡ ${Number(ev.proposals_count || 0)} оферти</div>
                    </td>
                    <td style="text-align: right; white-space: nowrap;">
                      <button class="btn btn-primary btn-sm" onclick="window.app.switchEvent('${escapeHtml(ev.id)}')">
                        👁️ Отвори
                      </button>
                      <button class="btn btn-secondary btn-sm" style="margin-left: 6px;" onclick="window.app.viewEventFinances('${escapeHtml(ev.id)}')">
                        💰 Финанси
                      </button>
                      ${ownerUser ? `
                        <button class="btn btn-danger btn-sm" style="margin-left: 6px;" onclick="window.app.handleDeleteEvent('${escapeHtml(ev.id)}')">
                          🗑️ Изтрий
                        </button>
                      ` : ""}
                    </td>
                  </tr>
                `;
              }).join("")}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  function renderEmptyEventsState() {
    const canCreateEvents = canManageAgencyFinances();
    return `
      <div class="empty-state">
        <div class="empty-state-icon">📅</div>
        <h3>${canCreateEvents ? "Все още няма създадени събития" : "Нямате възложени събития"}</h3>
        <p>
          ${canCreateEvents
            ? "Базата данни е напълно чиста. Натиснете бутона по-долу, за да създадете първото си събитие и да получите индивидуален линк за Вашия клиент."
            : "Все още нямате възложени събития като координатор. Когато собственик или мениджър Ви назначи към събитие, то ще се появи тук."}
        </p>
        ${canCreateEvents ? `
          <button class="btn btn-primary" onclick="window.app.openNewEventModal()" style="padding: 12px 24px; font-size: 15px;">
            ➕ Създай първо събитие
          </button>
        ` : ""}
      </div>
    `;
  }

  function renderEventsView(events, currentEvent) {
    if (!currentEvent) {
      return `<div style="text-align: center; padding: 40px; color: #64748b;">Зареждане на събитието...</div>`;
    }

    const clientLink = currentEvent.clientToken
      ? `${window.location.origin}/?token=${currentEvent.clientToken}`
      : (currentEvent.clientLink || '');

    return `
      <!-- Лента за превключване между събития -->
      <div style="display: flex; gap: 10px; margin-bottom: 20px; overflow-x: auto; padding-bottom: 4px; align-items: center;">
        <button class="btn btn-secondary btn-sm" onclick="window.app.switchView('events')">
          ← Всички събития
        </button>
        ${events.map(ev => `
          <button class="btn ${ev.id === state.currentEventId ? 'btn-primary' : 'btn-secondary'} btn-sm"
                  onclick="window.app.switchEvent('${ev.id}')">
            ${escapeHtml(ev.title)}
          </button>
        `).join('')}
      </div>

      <!-- Главна карта на избраното събитие -->
      <div class="card" style="margin-bottom: 24px; border-left: 4px solid var(--primary);">
        <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 16px;">
          <div>
            <div style="display: flex; align-items: center; gap: 10px; margin-bottom: 6px;">
              <h2 style="font-size: 22px; font-weight: 800; color: #0f172a;">${escapeHtml(currentEvent.title)}</h2>
              <span class="status-pill status-${escapeHtml(currentEvent.event_type || 'wedding')}" style="text-transform: capitalize;">${escapeHtml(getEventTypeLabel(currentEvent.event_type || 'wedding'))}</span>
            </div>
            <div style="color: #64748b; font-size: 14px; display: flex; gap: 18px; flex-wrap: wrap;">
              <span>📅 ${formatDate(currentEvent.starts_at)}</span>
              ${currentEvent.venue_label ? `<span>📍 ${escapeHtml(currentEvent.venue_label)}</span>` : ''}
              <span>👤 Клиент: <strong>${escapeHtml(currentEvent.clientName || 'Клиент')}</strong> (${escapeHtml(currentEvent.clientEmail || '')})</span>
            </div>
          </div>

          <div style="display: flex; gap: 10px; align-items: center; flex-wrap: wrap;">
            ${clientLink ? `
              <!-- БУТОН ЗА КОПИРАНЕ НА ЛИНКА ЗА КЛИЕНТА -->
              <button class="btn-copy-link" onclick="window.app.copyClientLink('${escapeHtml(clientLink)}')">
                🔗 Копирай линк за клиента
              </button>
              <button class="btn btn-secondary btn-sm" onclick="window.open('${escapeHtml(clientLink)}', '_blank')">
                👁️ Отвори като клиент
              </button>
            ` : '<span style="font-size: 12px; color: #94a3b8;">Няма генериран клиентски линк</span>'}
            ${isOwner() ? `
              <button class="btn btn-danger btn-sm" onclick="window.app.handleDeleteEvent('${escapeHtml(currentEvent.id)}')">
                🗑️ Изтрий събитието
              </button>
            ` : ''}
          </div>
        </div>
      </div>

      <!-- Табове на работното пространство -->
      <div style="display: flex; border-bottom: 2px solid #e2e8f0; margin-bottom: 24px; gap: 8px;">
        <button class="tab-btn ${state.activeTab === 'overview' ? 'active' : ''}" onclick="window.app.switchTab('overview')">
          📊 Общ преглед
        </button>
        <button class="tab-btn ${state.activeTab === 'milestones' ? 'active' : ''}" onclick="window.app.switchTab('milestones')">
          📋 Етапи и План (${currentEvent.milestones?.length || 0})
        </button>
        <button class="tab-btn ${state.activeTab === 'proposals' ? 'active' : ''}" onclick="window.app.switchTab('proposals')">
          ⚡ Оферти за избор (${currentEvent.proposals?.length || 0})
        </button>
        <button class="tab-btn ${state.activeTab === 'documents' ? 'active' : ''}" onclick="window.app.switchTab('documents')">
          📁 Документи (${currentEvent.documents?.length || 0})
        </button>
        <button class="tab-btn ${state.activeTab === 'finances' ? 'active' : ''}" onclick="window.app.switchTab('finances')">
          💳 Бюджет & Плащания
        </button>
      </div>

      <!-- Съдържание на таба -->
      <div>
        ${state.activeTab === 'overview' ? renderStaffOverview(currentEvent) : ''}
        ${state.activeTab === 'milestones' ? renderStaffMilestones(currentEvent) : ''}
        ${state.activeTab === 'proposals' ? renderStaffProposals(currentEvent) : ''}
        ${state.activeTab === 'documents' ? renderStaffDocuments(currentEvent) : ''}
        ${state.activeTab === 'finances' ? renderStaffEventFinances(currentEvent) : ''}
      </div>
    `;
  }

  function renderStaffOverview(currentEvent) {
    const clientLink = currentEvent.clientToken
      ? `${window.location.origin}/?token=${currentEvent.clientToken}`
      : (currentEvent.clientLink || '');
    return `
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; margin-bottom: 24px;">
        <div class="card" style="padding: 20px;">
          <div style="color: #64748b; font-size: 13px; font-weight: 600; text-transform: uppercase;">Линк за споделяне</div>
          <div style="margin: 10px 0; font-size: 13px; background: #f1f5f9; padding: 8px 10px; border-radius: 6px; word-break: break-all; color: #1e293b; font-family: monospace;">
            ${escapeHtml(clientLink)}
          </div>
          <button class="btn btn-primary btn-sm" onclick="window.app.copyClientLink('${escapeHtml(clientLink)}')">
            📋 Копирай линка
          </button>
        </div>

        <div class="card" style="padding: 20px;">
          <div style="color: #64748b; font-size: 13px; font-weight: 600; text-transform: uppercase;">Етапи на събитието</div>
          <div style="font-size: 32px; font-weight: 800; color: #0f172a; margin: 6px 0;">${currentEvent.milestones?.length || 0}</div>
          <div style="color: #64748b; font-size: 13px;">Общо планирани задачи и срокове</div>
        </div>

        <div class="card" style="padding: 20px;">
          <div style="color: #64748b; font-size: 13px; font-weight: 600; text-transform: uppercase;">Оферти за избор от клиента</div>
          <div style="font-size: 32px; font-weight: 800; color: #0f172a; margin: 6px 0;">${currentEvent.proposals?.length || 0}</div>
          <div style="color: #64748b; font-size: 13px;">Варианти с опции за одобрение</div>
        </div>
      </div>
    `;
  }

  function renderStaffMilestones(currentEvent) {
    const milestones = currentEvent.milestones || [];
    return `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
        <h3 style="font-size: 18px; font-weight: 700;">План на събитието и срокове</h3>
        <button class="btn btn-primary btn-sm" onclick="window.app.openNewMilestoneModal()">➕ Добави нов етап</button>
      </div>

      ${milestones.length === 0 ? `
        <div class="empty-state" style="padding: 40px 20px;">
          <div class="empty-state-icon">📋</div>
          <h4>Няма въведени етапи</h4>
          <p>Добавете важни срокове като "Избор на локация", "Декорация", "Кетъринг", за да ги следите и споделяте с клиента.</p>
          <button class="btn btn-primary btn-sm" onclick="window.app.openNewMilestoneModal()">➕ Добави първи етап</button>
        </div>
      ` : `
        <div style="display: flex; flex-direction: column; gap: 12px;">
          ${milestones.map(m => `
            <div class="card" style="display: flex; justify-content: space-between; align-items: center; padding: 16px 20px;">
              <div>
                <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
                  <strong style="font-size: 16px;">${escapeHtml(m.title)}</strong>
                  <span class="status-pill status-${m.status || 'planned'}">${escapeHtml(m.status || 'planned')}</span>
                  ${m.is_published ? '<span style="font-size: 11px; background: #e3f0e6; color: #143d22; padding: 2px 8px; border-radius: 12px; font-weight: 600;">Публикуван за клиента</span>' : '<span style="font-size: 11px; background: #f1f5f9; color: #64748b; padding: 2px 8px; border-radius: 12px;">Вътрешна чернова</span>'}
                </div>
                <div style="color: #64748b; font-size: 13px;">
                  <span>Краен срок: <strong>${formatDate(m.due_date)}</strong></span> &bull; 
                  <span>Категория: ${escapeHtml(m.category || 'Общи')}</span> &bull; 
                  <span>Следваща стъпка: ${escapeHtml(m.next_step || 'В процес')}</span>
                </div>
              </div>
            </div>
          `).join('')}
        </div>
      `}
    `;
  }

  function renderStaffProposals(currentEvent) {
    const proposals = currentEvent.proposals || [];
    return `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 16px;">
        <h3 style="font-size: 18px; font-weight: 700;">Предложения за избор от клиента</h3>
        <button class="btn btn-primary btn-sm" onclick="window.app.openNewProposalModal()">➕ Ново предложение за избор</button>
      </div>

      ${proposals.length === 0 ? `
        <div class="empty-state" style="padding: 40px 20px;">
          <div class="empty-state-icon">⚡</div>
          <h4>Няма предложения за решение</h4>
          <p>Създайте оферта с варианти (напр. "Меню Вариант А" vs "Меню Вариант Б"), за да може клиентът да избере и одобри през своя портал.</p>
          <button class="btn btn-primary btn-sm" onclick="window.app.openNewProposalModal()">➕ Създай първо предложение</button>
        </div>
      ` : `
        <div style="display: flex; flex-direction: column; gap: 16px;">
          ${proposals.map(p => `
            <div class="card" style="padding: 20px;">
              <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px;">
                <h4 style="font-size: 17px; font-weight: 700;">${escapeHtml(p.title)}</h4>
                ${p.response ? `
                  <span style="background: #e3f0e6; color: #143d22; padding: 4px 12px; border-radius: 20px; font-weight: 700; font-size: 13px;">
                    ✅ Клиентът одобри на ${formatDate(p.response.decided_at)}
                  </span>
                ` : `
                  <span style="background: #fef3c7; color: #92400e; padding: 4px 12px; border-radius: 20px; font-weight: 700; font-size: 13px;">
                    ⏳ Очаква се решение от клиента
                  </span>
                `}
              </div>

              <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px;">
                ${(p.options || []).map(opt => `
                  <div style="border: 2px solid ${p.response?.selected_option_id === opt.id ? '#1e4d2b' : '#e2e8f0'}; background: ${p.response?.selected_option_id === opt.id ? '#f2f7f3' : '#ffffff'}; padding: 14px; border-radius: 8px; display: flex; flex-direction: column; justify-content: space-between; gap: 8px;">
                    <div>
                      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
                        <strong>${escapeHtml(opt.title)}</strong>
                        <span style="font-weight: 700; color: #2563eb;">${formatEUR(opt.total_cents)}</span>
                      </div>
                      <p style="color: #64748b; font-size: 13px; margin: 0;">${escapeHtml(opt.description || 'Няма описание')}</p>
                    </div>
                    ${p.response?.selected_option_id === opt.id ? '<div style="color: #143d22; font-size: 12px; font-weight: 700;">★ Избран вариант</div>' : ''}
                    ${!p.response && p.active_request_id && isOwner() ? `
                      <div>
                        <button class="btn btn-secondary btn-sm" style="width: 100%; font-size: 12px;"
                                onclick="window.app.submitOwnerDecision('${escapeHtml(p.active_request_id)}', '${escapeHtml(opt.id)}', '${escapeHtml(opt.title)}')">
                          ✅ Одобри като Собственик
                        </button>
                      </div>
                    ` : ''}
                  </div>
                `).join('')}
              </div>

              ${p.response?.comment ? `
                <div style="margin-top: 12px; padding: 10px 14px; background: #f8fafc; border-left: 3px solid #2563eb; border-radius: 4px; font-size: 13px; color: #334155;">
                  💬 Коментар от клиента: "${escapeHtml(p.response.comment)}"
                </div>
              ` : ''}
            </div>
          `).join('')}
        </div>
      `}
    `;
  }

  function renderStaffDocuments(currentEvent) {
    const docs = currentEvent.documents || [];
    return `
      <div class="card" style="margin-bottom: 24px; padding: 20px;">
        <h4 style="font-size: 16px; font-weight: 700; margin-bottom: 14px;">Качване на нов документ</h4>
        <form onsubmit="window.app.handleDocumentUpload(event)" style="display: flex; gap: 12px; flex-wrap: wrap; align-items: flex-end;">
          <div style="flex: 2; min-width: 200px;">
            <label style="display: block; font-size: 13px; font-weight: 600; margin-bottom: 4px;">Заглавие</label>
            <input type="text" name="title" class="form-control" placeholder="напр. Договор за кетъринг" required />
          </div>
          <div style="flex: 1; min-width: 140px;">
            <label style="display: block; font-size: 13px; font-weight: 600; margin-bottom: 4px;">Категория</label>
            <select name="category" class="form-control">
              <option value="Оферти">Оферти</option>
              <option value="Договори">Договори</option>
              <option value="Схеми">Схеми</option>
              <option value="Общи">Общи</option>
            </select>
          </div>
          <div style="flex: 2; min-width: 220px;">
            <label style="display: block; font-size: 13px; font-weight: 600; margin-bottom: 4px;">Файл (PDF, JPG, PNG)</label>
            <input type="file" name="file" class="form-control" accept=".pdf,.jpg,.jpeg,.png" required />
          </div>
          <div style="display: flex; align-items: center; gap: 6px; padding-bottom: 8px;">
            <input type="checkbox" id="audience-client" name="audienceClient" checked />
            <label for="audience-client" style="font-size: 13px; cursor: pointer;">Видим за клиента</label>
          </div>
          <button type="submit" class="btn btn-primary" style="height: 42px;">Качи файл</button>
        </form>
      </div>

      <h4 style="font-size: 17px; font-weight: 700; margin-bottom: 12px;">Качени файлове (${docs.length})</h4>
      ${docs.length === 0 ? `
        <div style="color: #64748b; font-size: 14px; padding: 20px; text-align: center; background: #ffffff; border-radius: 8px;">
          Все още няма качени файлове за това събитие.
        </div>
      ` : `
        <div style="display: flex; flex-direction: column; gap: 10px;">
          ${docs.map(d => `
            <div class="card" style="display: flex; justify-content: space-between; align-items: center; padding: 14px 18px;">
              <div>
                <strong>${escapeHtml(d.title)}</strong>
                <div style="color: #64748b; font-size: 13px; margin-top: 2px;">
                  <span>${escapeHtml(d.original_name)}</span> &bull; 
                  <span>Категория: ${escapeHtml(d.category)}</span> &bull; 
                  <span>${(d.byte_size / 1024).toFixed(1)} KB</span>
                </div>
              </div>
              <button class="btn btn-secondary btn-sm" onclick="window.app.downloadDoc('${d.id}')">
                ⬇️ Изтегли
              </button>
            </div>
          `).join('')}
        </div>
      `}
    `;
  }

  // ─── ФИНАНСОВИ И ОПЕРАТИВНИ ИЗГЛЕДИ ЗА АГЕНЦИЯТА ────────────────────────────

  function renderStaffEventFinances(currentEvent) {
    const budget = currentEvent.budget || {};
    const payments = currentEvent.payments || {};
    const internalItems = currentEvent.internalItems || [];
    const canManageFinances = canManageAgencyFinances();

    let supplierTotalCents = 0;
    (internalItems || []).forEach(it => {
      supplierTotalCents += Number(it.internal_cost_cents || it.cost_cents || 0);
    });

    const budgetTotalCents = Number(budget.activeTotalCents || 0) || (internalItems.reduce((acc, it) => acc + Number(it.total_cents || it.client_total_cents || 0), 0));
    const marginCents = budgetTotalCents - supplierTotalCents;
    const marginPercent = budgetTotalCents > 0 ? Math.round((marginCents / budgetTotalCents) * 100) : 0;

    const displayBudgetEUR = budget.activeTotalEUR || formatEUR(budgetTotalCents);
    const displayPaidEUR = payments.netPaidEUR || formatEUR(0);
    const displayBalanceEUR = payments.balanceEUR || formatEUR(budgetTotalCents);
    const isOverpaid = !!payments.isOverpaid;

    return `
      <!-- Финансови KPI за избраното събитие -->
      <div class="finance-kpi-grid" style="margin-bottom: 24px;">
        <div class="finance-kpi-card kpi-turnover">
          <div class="finance-kpi-label">📋 Договорен бюджет</div>
          <div class="finance-kpi-value">${escapeHtml(displayBudgetEUR)}</div>
          <div class="finance-kpi-sub">Крайна цена за клиента</div>
        </div>

        <div class="finance-kpi-card kpi-collected">
          <div class="finance-kpi-label">💳 Платено от клиента</div>
          <div class="finance-kpi-value" style="color: #1e4d2b;">${escapeHtml(displayPaidEUR)}</div>
          <div class="finance-kpi-sub">Реално постъпили средства</div>
        </div>

        <div class="finance-kpi-card kpi-pending">
          <div class="finance-kpi-label">${isOverpaid ? '✅ Надплатена сума' : '⏳ Дължим остатък'}</div>
          <div class="finance-kpi-value" style="color: ${isOverpaid ? '#0284c7' : '#b45309'};">${isOverpaid ? '+' : ''}${escapeHtml(displayBalanceEUR)}</div>
          <div class="finance-kpi-sub">${isOverpaid ? 'Платеното надвишава текущия договорен бюджет' : 'Остатък за финално събиране'}</div>
        </div>

        <div class="finance-kpi-card kpi-margin">
          <div class="finance-kpi-label">📈 Брутна печалба (Марж)</div>
          <div class="finance-kpi-value" style="color: #0e7490;">${escapeHtml(formatEUR(marginCents))}</div>
          <div class="finance-kpi-sub">
            <span class="margin-pill">${marginPercent}% марж</span> &bull; 
            <span>Подизпълнители: ${escapeHtml(formatEUR(supplierTotalCents))}</span>
          </div>
        </div>
      </div>

      <!-- Бюджетни пера & Разходи към подизпълнители -->
      <div class="finance-table-card" style="margin-bottom: 24px;">
        <div class="card-header">
          <h3 style="font-size: 16px; font-weight: 700; color: #1e293b; margin: 0;">
            🧾 Бюджетни пера & Подизпълнители
          </h3>
          ${canManageFinances ? `
            <button class="btn btn-primary btn-sm" onclick="window.app.openNewBudgetItemModal('${currentEvent.id}')">
              ➕ Добави перо в бюджета
            </button>
          ` : ''}
        </div>
        <div class="finance-table-wrapper">
          <table class="finance-table">
            <thead>
              <tr>
                <th>Категория</th>
                <th>Описание за клиента</th>
                <th>Цена за клиент</th>
                <th>Подизпълнител</th>
                <th>Разход агенция</th>
                <th>Марж / Печалба</th>
              </tr>
            </thead>
            <tbody>
              ${(!internalItems || internalItems.length === 0) ? `
                <tr>
                  <td colspan="6" style="text-align: center; padding: 24px; color: #64748b;">
                    Все още няма въведени пера в бюджета на събитието.
                  </td>
                </tr>
              ` : internalItems.map(item => {
                const clientPriceCents = Number(item.total_cents || item.client_total_cents || 0);
                const supplierCostCents = Number(item.internal_cost_cents || item.cost_cents || 0);
                const itemMarginCents = clientPriceCents - supplierCostCents;
                const itemMarginEUR = (itemMarginCents / 100).toFixed(2);
                return `
                  <tr>
                    <td><strong>${escapeHtml(item.category)}</strong></td>
                    <td>${escapeHtml(item.client_description)}</td>
                    <td style="font-weight: 700; color: #1e293b;">${formatEUR(clientPriceCents)}</td>
                    <td>
                      <div>${escapeHtml(item.supplier_name || 'Собствено изпълнение')}</div>
                      ${item.internal_note ? `<div style="font-size: 11px; color: #64748b; font-style: italic;">Бележка: ${escapeHtml(item.internal_note)}</div>` : ''}
                    </td>
                    <td style="color: #64748b;">${formatEUR(supplierCostCents)}</td>
                    <td>
                      <span class="margin-pill">€${escapeHtml(itemMarginEUR)}</span>
                    </td>
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <!-- График на вноските и Дневник на плащанията (2 колони) -->
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(440px, 1fr)); gap: 20px;">
        <!-- График на плащанията -->
        <div class="finance-table-card">
          <div class="card-header">
            <h3 style="font-size: 16px; font-weight: 700; color: #1e293b; margin: 0;">
              📅 График на вноските
            </h3>
            ${canManageFinances ? `
              <button class="btn btn-secondary btn-sm" onclick="window.app.openNewScheduleModal('${currentEvent.id}')">
                ➕ Нова вноска
              </button>
            ` : ''}
          </div>
          <div class="finance-table-wrapper">
            <table class="finance-table">
              <thead>
                <tr>
                  <th>Вноска</th>
                  <th>Падежна дата</th>
                  <th>Сума</th>
                  <th>Статус</th>
                </tr>
              </thead>
              <tbody>
                ${(!payments.schedules || payments.schedules.length === 0) ? `
                  <tr>
                    <td colspan="4" style="text-align: center; padding: 20px; color: #64748b;">
                      Няма зададен график за плащане.
                    </td>
                  </tr>
                ` : payments.schedules.map(sch => `
                  <tr>
                    <td><strong>${escapeHtml(sch.label)}</strong></td>
                    <td>${formatDate(sch.due_date || sch.dueDate)}</td>
                    <td style="font-weight: 700;">${escapeHtml(sch.amountEUR || formatEUR(sch.amount_cents))}</td>
                    <td>
                      ${sch.state === 'paid' ? '<span class="finance-badge badge-paid">✅ Платено</span>' :
                        '<span class="finance-badge badge-pending">⏳ Очаква се</span>'}
                    </td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>

        <!-- Постъпили плащания -->
        <div class="finance-table-card">
          <div class="card-header">
            <h3 style="font-size: 16px; font-weight: 700; color: #1e293b; margin: 0;">
              💳 Регистрирани плащания
            </h3>
            ${canManageFinances ? `
              <button class="btn btn-primary btn-sm" onclick="window.app.openNewPaymentModal('${currentEvent.id}')">
                ➕ Запиши плащане
              </button>
            ` : ''}
          </div>
          <div class="finance-table-wrapper">
            <table class="finance-table">
              <thead>
                <tr>
                  <th>Дата</th>
                  <th>Основание / Бележка</th>
                  <th>Сума</th>
                  <th>Записал</th>
                </tr>
              </thead>
              <tbody>
                ${(!payments.entries || payments.entries.length === 0) ? `
                  <tr>
                    <td colspan="4" style="text-align: center; padding: 20px; color: #64748b;">
                      Няма регистрирани плащания за това събитие.
                    </td>
                  </tr>
                ` : payments.entries.map(ent => `
                  <tr>
                    <td>${formatDate(ent.effective_date || ent.effectiveDate || ent.created_at)}</td>
                    <td>${escapeHtml(ent.reference || 'Плащане от клиент')}</td>
                    <td style="font-weight: 700; color: #1e4d2b;">${escapeHtml(ent.amountEUR || formatEUR(ent.signed_amount_cents))}</td>
                    <td style="font-size: 12px; color: #64748b;">${escapeHtml(ent.recorded_by_name || ent.recordedByName || 'Служител')}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;
  }

  function renderAgencyFinancesView() {
    const data = state.financesData;
    if (!data) {
      return `
        <div style="text-align: center; padding: 60px 20px; color: #64748b;">
          <div class="spinner" style="margin-bottom: 16px;">⏳</div>
          <p>Зареждане на финансовия отчет на агенцията...</p>
        </div>
      `;
    }

    const events = data.events || [];
    const upcomingSchedules = data.upcomingSchedules || [];
    const recentPayments = data.recentPayments || [];
    const canManageFinances = canManageAgencyFinances();

    return `
      <!-- 4 Главни Финансови Показателя (KPIs) -->
      <div class="finance-kpi-grid">
        <div class="finance-kpi-card kpi-turnover">
          <div class="finance-kpi-label">📋 Договорен оборот</div>
          <div class="finance-kpi-value">€${escapeHtml(data.totalBudgetEUR || '0.00')}</div>
          <div class="finance-kpi-sub">Обща стойност на договорените бюджети (${events.length} събития)</div>
        </div>

        <div class="finance-kpi-card kpi-collected">
          <div class="finance-kpi-label">💳 Постъпили плащания</div>
          <div class="finance-kpi-value" style="color: #1e4d2b;">€${escapeHtml(data.totalPaidEUR || '0.00')}</div>
          <div class="finance-kpi-sub">Събрани депозити, капаро и междинни плащания</div>
        </div>

        <div class="finance-kpi-card kpi-pending">
          <div class="finance-kpi-label">⏳ Чакащи вземания</div>
          <div class="finance-kpi-value" style="color: #b45309;">€${escapeHtml(data.totalPendingEUR || '0.00')}</div>
          <div class="finance-kpi-sub">Остатък за събиране от клиенти по договори</div>
        </div>

        <div class="finance-kpi-card kpi-margin">
          <div class="finance-kpi-label">📈 Брутен марж на агенцията</div>
          <div class="finance-kpi-value" style="color: #0e7490;">€${escapeHtml(data.totalMarginEUR || '0.00')}</div>
          <div class="finance-kpi-sub">
            <span class="margin-pill">${data.totalMarginPercent || 0}% марж</span> &bull; 
            <span>Разходи подизпълнители: €${escapeHtml(data.totalSupplierEUR || '0.00')}</span>
          </div>
        </div>
      </div>

      <!-- Таблица с разбивка по събития -->
      <div class="finance-table-card">
        <div class="card-header">
          <h3 style="font-size: 17px; font-weight: 700; color: #1e293b; margin: 0;">
            📊 Финансова справка по събития
          </h3>
          ${canManageFinances ? `
            <button class="btn btn-primary btn-sm" onclick="window.app.openNewPaymentModal()">
              ➕ Запиши ново плащане
            </button>
          ` : ''}
        </div>
        <div class="finance-table-wrapper">
          <table class="finance-table">
            <thead>
              <tr>
                <th>Събитие & Дата</th>
                <th>Клиент</th>
                <th>Договорен бюджет</th>
                <th>Платено досега</th>
                <th>Остатък за плащане</th>
                <th>Разходи (Подизпълнители)</th>
                <th>Марж на агенцията</th>
                <th>Статус</th>
                <th style="text-align: right;">Действия</th>
              </tr>
            </thead>
            <tbody>
              ${events.length === 0 ? `
                <tr>
                  <td colspan="9" style="text-align: center; padding: 30px; color: #64748b;">
                    Все още няма финансови записи за събития.
                  </td>
                </tr>
              ` : events.map(ev => `
                <tr>
                  <td>
                    <strong style="color: #1e293b; display: block;">${escapeHtml(ev.title)}</strong>
                    <span style="font-size: 12px; color: #64748b;">📅 ${formatDate(ev.startsAt)} ${ev.venueLabel ? `&bull; 📍 ${escapeHtml(ev.venueLabel)}` : ''}</span>
                  </td>
                  <td>
                    <div style="font-weight: 600;">${escapeHtml(ev.clientName || 'Клиент')}</div>
                    <div style="font-size: 12px; color: #64748b;">${escapeHtml(ev.clientEmail || '')}</div>
                  </td>
                  <td style="font-weight: 700;">€${escapeHtml(ev.budgetEUR)}</td>
                  <td style="font-weight: 700; color: #1e4d2b;">€${escapeHtml(ev.paidEUR)}</td>
                  <td>
                    ${ev.isOverpaid ? `
                      <span style="color: #0284c7; font-weight: 600;">Надплатено: €${escapeHtml(ev.balanceEUR)}</span>
                    ` : `
                      <span style="color: ${Number(ev.balanceEUR) > 0 ? '#b45309' : '#64748b'}; font-weight: 600;">€${escapeHtml(ev.balanceEUR)}</span>
                    `}
                  </td>
                  <td style="color: #64748b;">€${escapeHtml(ev.supplierEUR)}</td>
                  <td>
                    <span class="margin-pill">€${escapeHtml(ev.marginEUR)} (${ev.marginPercent}%)</span>
                  </td>
                  <td>
                    ${ev.status === 'paid' ? '<span class="finance-badge badge-paid">✅ Платено</span>' :
                      ev.status === 'partial' ? '<span class="finance-badge badge-partial">⏳ Частично</span>' :
                      '<span class="finance-badge badge-pending">🔴 Очаква се</span>'}
                  </td>
                  <td style="text-align: right; white-space: nowrap;">
                    <button class="btn btn-secondary btn-sm" onclick="window.app.viewEventFinances('${ev.id}')" style="padding: 4px 8px; font-size: 12px;">
                      Детайли
                    </button>
                    ${canManageFinances ? `
                      <button class="btn btn-primary btn-sm" onclick="window.app.openNewPaymentModal('${ev.id}')" style="padding: 4px 8px; font-size: 12px; margin-left: 4px;">
                        ➕ Плащане
                      </button>
                    ` : ''}
                  </td>
                </tr>
              `).join('')}
            </tbody>
          </table>
        </div>
      </div>

      <!-- График на вноските & Дневник на плащанията (2 колони) -->
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(460px, 1fr)); gap: 20px;">
        <!-- Предстоящи плащания по график -->
        <div class="finance-table-card">
          <div class="card-header">
            <h3 style="font-size: 16px; font-weight: 700; color: #1e293b; margin: 0;">
              📅 Предстоящи вноски по график
            </h3>
            ${canManageFinances ? `
              <button class="btn btn-secondary btn-sm" onclick="window.app.openNewScheduleModal()">
                ➕ Нова вноска
              </button>
            ` : ''}
          </div>
          <div class="finance-table-wrapper">
            <table class="finance-table">
              <thead>
                <tr>
                  <th>Вноска / Описание</th>
                  <th>Събитие</th>
                  <th>Падеж</th>
                  <th>Сума</th>
                  <th>Статус</th>
                </tr>
              </thead>
              <tbody>
                ${upcomingSchedules.length === 0 ? `
                  <tr>
                    <td colspan="5" style="text-align: center; padding: 24px; color: #64748b;">
                      Няма предстоящи чакащи вноски.
                    </td>
                  </tr>
                ` : upcomingSchedules.map(s => `
                  <tr>
                    <td><strong>${escapeHtml(s.label)}</strong></td>
                    <td style="font-size: 12px; color: #64748b;">${escapeHtml(s.event_title)}</td>
                    <td>${formatDate(s.due_date)}</td>
                    <td style="font-weight: 700;">€${escapeHtml(s.amountEUR)}</td>
                    <td><span class="finance-badge badge-pending">${escapeHtml(s.state)}</span></td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>

        <!-- Последно постъпили плащания -->
        <div class="finance-table-card">
          <div class="card-header">
            <h3 style="font-size: 16px; font-weight: 700; color: #1e293b; margin: 0;">
              💳 Дневник на постъпилите плащания
            </h3>
            ${canManageFinances ? `
              <button class="btn btn-primary btn-sm" onclick="window.app.openNewPaymentModal()">
                ➕ Запиши плащане
              </button>
            ` : ''}
          </div>
          <div class="finance-table-wrapper">
            <table class="finance-table">
              <thead>
                <tr>
                  <th>Дата</th>
                  <th>Събитие</th>
                  <th>Основание</th>
                  <th>Сума</th>
                  <th>Записал</th>
                </tr>
              </thead>
              <tbody>
                ${recentPayments.length === 0 ? `
                  <tr>
                    <td colspan="5" style="text-align: center; padding: 24px; color: #64748b;">
                      Няма регистрирани плащания.
                    </td>
                  </tr>
                ` : recentPayments.map(p => `
                  <tr>
                    <td>${formatDate(p.effective_date || p.created_at)}</td>
                    <td style="font-size: 12px; color: #64748b;">${escapeHtml(p.event_title)}</td>
                    <td>${escapeHtml(p.reference || 'Плащане от клиент')}</td>
                    <td style="font-weight: 700; color: #1e4d2b;">€${escapeHtml(p.amountEUR)}</td>
                    <td style="font-size: 12px; color: #64748b;">${escapeHtml(p.recorded_by_name || 'Служител')}</td>
                  </tr>
                `).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    `;
  }

  function renderAgencyDashboardView(events) {
    const data = state.financesData;
    return `
      <div class="card" style="margin-bottom: 24px; padding: 24px; background: linear-gradient(135deg, #0b2413 0%, #143d22 55%, #1e4d2b 100%); color: #ffffff;">
        <h2 style="font-size: 24px; font-weight: 800; margin-bottom: 8px; color: #ffffff;">
          Здравейте, ${escapeHtml(state.user?.displayName || 'Sando')}! 👋
        </h2>
        <p style="font-size: 15px; color: #d5e8d9; margin: 0; max-width: 650px;">
          Добре дошли в оперативното табло на SaZa Event Management. Тук имате бърз поглед над активните събития, клиентските избори и финансовото състояние на агенцията.
        </p>
      </div>

      <div class="finance-kpi-grid">
        <div class="finance-kpi-card kpi-turnover">
          <div class="finance-kpi-label">📅 Активни събития</div>
          <div class="finance-kpi-value">${events.length}</div>
          <div class="finance-kpi-sub">В процес на планиране и изпълнение</div>
        </div>

        <div class="finance-kpi-card kpi-collected">
          <div class="finance-kpi-label">💳 Оборот на агенцията</div>
          <div class="finance-kpi-value">€${escapeHtml(data?.totalBudgetEUR || '0.00')}</div>
          <div class="finance-kpi-sub">Договорени бюджети с клиенти</div>
        </div>

        <div class="finance-kpi-card kpi-margin">
          <div class="finance-kpi-label">📈 Брутен марж</div>
          <div class="finance-kpi-value" style="color: #0e7490;">€${escapeHtml(data?.totalMarginEUR || '0.00')}</div>
          <div class="finance-kpi-sub"><span class="margin-pill">${data?.totalMarginPercent || 0}% марж</span> за агенцията</div>
        </div>

        <div class="finance-kpi-card kpi-pending">
          <div class="finance-kpi-label">⏳ Чакащи плащания</div>
          <div class="finance-kpi-value" style="color: #b45309;">€${escapeHtml(data?.totalPendingEUR || '0.00')}</div>
          <div class="finance-kpi-sub">Остатък за събиране</div>
        </div>
      </div>

      <div class="card" style="padding: 24px;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 18px; flex-wrap: wrap; gap: 10px;">
          <h3 style="font-size: 18px; font-weight: 700; color: #1e293b; margin: 0;">
            📅 Активни събития на агенцията
          </h3>
          <div style="display: flex; gap: 8px; flex-wrap: wrap;">
            <button class="btn btn-secondary btn-sm" onclick="window.app.switchView('events')">
              📋 Списък с всички събития
            </button>
            ${canManageAgencyFinances() ? `
              <button class="btn btn-primary btn-sm" onclick="window.app.openNewEventModal()">
                ➕ Ново събитие
              </button>
            ` : ''}
          </div>
        </div>

        ${events.length === 0 ? `
          <div style="color: #64748b; font-size: 14px; padding: 20px; text-align: center; background: #f8fafc; border-radius: 8px;">
            Нямате активни събития към момента.
          </div>
        ` : `
          <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(320px, 1fr)); gap: 16px;">
            ${events.map(ev => `
              <div style="border: 1px solid #e2e8f0; border-radius: 8px; padding: 18px; background: #ffffff; display: flex; flex-direction: column; justify-content: space-between; gap: 14px;">
                <div>
                  <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 8px;">
                    <strong style="font-size: 16px; color: #0f172a;">${escapeHtml(ev.title)}</strong>
                    <span class="status-pill status-${escapeHtml(ev.event_type || 'wedding')}">${escapeHtml(getEventTypeLabel(ev.event_type || 'wedding'))}</span>
                  </div>
                  <div style="font-size: 13px; color: #64748b; margin-bottom: 6px;">📅 ${formatDate(ev.starts_at)}</div>
                  ${ev.venue_label ? `<div style="font-size: 13px; color: #64748b;">📍 ${escapeHtml(ev.venue_label)}</div>` : ''}
                </div>

                <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                  <button class="btn btn-primary btn-sm" style="flex: 1;" onclick="window.app.switchEvent('${ev.id}')">
                    Отвори събитието
                  </button>
                  <button class="btn btn-secondary btn-sm" onclick="window.app.viewEventFinances('${ev.id}')">
                    💰 Финанси
                  </button>
                  ${isOwner() ? `
                    <button class="btn btn-danger btn-sm" title="Изтрий събитието" onclick="window.app.handleDeleteEvent('${ev.id}')">
                      🗑️
                    </button>
                  ` : ''}
                </div>
              </div>
            `).join('')}
          </div>
        `}
      </div>
    `;
  }

  const AGENCY_ROLE_OPTIONS = [
    {
      value: 'owner',
      label: '👑 Собственик (Owner)',
      description: 'Пълен достъп: абсолютно всички действия — събития (вкл. изтриване), финанси, документи, профили и промяна на роли.',
    },
    {
      value: 'manager',
      label: '💼 Мениджър (Manager)',
      description: 'Управлява събития, бюджети, плащания, етапи и клиентски оферти.',
    },
    {
      value: 'coordinator',
      label: '📋 Координатор (Coordinator)',
      description: 'Работи само по възложените му събития, без права за администрация.',
    },
  ];

  function renderRoleOptions(selectedRole) {
    return AGENCY_ROLE_OPTIONS.map(r => `
      <option value="${r.value}" ${selectedRole === r.value ? 'selected' : ''}>${r.label}</option>
    `).join('');
  }

  function renderUserStatusBadge(status) {
    if (status === 'active') {
      return `<span class="finance-badge badge-paid">🟢 Активен</span>`;
    }
    if (status === 'suspended') {
      return `<span class="finance-badge badge-partial">⏸️ Временно спрян</span>`;
    }
    return `<span class="finance-badge badge-overdue">🚫 Деактивиран</span>`;
  }

  function renderAgencyUsersView() {
    const isOwner = state.user?.role === 'owner';
    const users = state.users || [];
    const clients = state.clients || [];
    const q = (state.userSearch || '').trim().toLowerCase();

    const filteredUsers = !q ? users : users.filter(u =>
      [u.displayName, u.username, u.email, u.role].some(v => String(v || '').toLowerCase().includes(q))
    );
    const filteredClients = !q ? clients : clients.filter(c =>
      [c.displayName, c.email, c.eventTitle, c.clientRole].some(v => String(v || '').toLowerCase().includes(q))
    );

    const activeCount = users.filter(u => u.status === 'active').length;
    const ownersCount = users.filter(u => u.role === 'owner' && u.status === 'active').length;
    const staffRestCount = users.filter(u => (u.role === 'manager' || u.role === 'coordinator') && u.status === 'active').length;

    return `
      <div style="margin-bottom: 24px; display: flex; justify-content: space-between; align-items: flex-start; gap: 16px; flex-wrap: wrap;">
        <div>
          <h2 style="font-size: 22px; font-weight: 800; color: #0f172a; margin: 0 0 6px 0;">
            👥 Хора, профили и роли в агенцията
          </h2>
          <p style="font-size: 14px; color: #64748b; margin: 0;">
            ${isOwner
              ? 'Списък на целия екип и клиентите по събития. Като Собственик можете да създавате нови профили и да променяте ролите по всяко време.'
              : 'Списък на екипа в агенцията. Само потребители с роля Собственик (Owner) могат да добавят нови профили и да променят роли.'}
          </p>
        </div>
        ${isOwner ? `
          <button class="btn btn-primary" onclick="window.app.openNewUserModal()">
            ➕ Добави нов профил
          </button>
        ` : ''}
      </div>

      <div class="finance-kpi-grid">
        <div class="finance-kpi-card kpi-turnover">
          <div class="finance-kpi-label">👥 Профили в екипа</div>
          <div class="finance-kpi-value">${users.length}</div>
          <div class="finance-kpi-sub">${activeCount} активни акаунта</div>
        </div>

        <div class="finance-kpi-card kpi-collected">
          <div class="finance-kpi-label">👑 Собственици (Owner)</div>
          <div class="finance-kpi-value">${ownersCount}</div>
          <div class="finance-kpi-sub">Управляват хора, роли и финанси</div>
        </div>

        <div class="finance-kpi-card kpi-margin">
          <div class="finance-kpi-label">💼 Мениджъри & Координатори</div>
          <div class="finance-kpi-value" style="color: #0e7490;">${staffRestCount}</div>
          <div class="finance-kpi-sub">Активен оперативен екип</div>
        </div>

        <div class="finance-kpi-card kpi-pending">
          <div class="finance-kpi-label">${isOwner ? '💌 Клиентски профили' : '📅 Възложени събития'}</div>
          <div class="finance-kpi-value" style="color: #143d22;">${isOwner ? clients.length : (state.events || []).length}</div>
          <div class="finance-kpi-sub">${isOwner ? 'Клиенти с достъп до портал' : 'Видими за Вашия профил'}</div>
        </div>
      </div>

      <div class="card" style="padding: 16px 20px; margin-bottom: 20px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap;">
        <div style="flex: 1; min-width: 240px;">
          <input id="users-search-input"
                 type="search"
                 class="form-control"
                 placeholder="🔎 Търси по име, потребител, имейл, роля или събитие..."
                 value="${escapeHtml(state.userSearch || '')}"
                 oninput="window.app.setUserSearch(this.value)" />
        </div>
        ${state.userSearch ? `
          <button class="btn btn-secondary btn-sm" onclick="window.app.setUserSearch('')">✕ Изчисти</button>
        ` : ''}
      </div>

      ${!isOwner ? `
        <div class="card" style="padding: 14px 18px; margin-bottom: 20px; border-left: 4px solid #0e7490; background: #f0f9ff;">
          <strong style="color: #0e7490;">ℹ️ Режим само за преглед:</strong>
          <span style="color: #334155; font-size: 13px;">
            Вие сте влезли с роля <strong>${getRoleLabel(state.user?.role)}</strong>. За създаване на нови акаунти или промяна на роли се свържете със Собственик (Owner).
          </span>
        </div>
      ` : ''}

      <!-- Таблица: Екип на агенцията -->
      <div class="finance-table-card" style="margin-bottom: 24px;">
        <div class="card-header">
          <h3 style="font-size: 16px; font-weight: 700; color: #1e293b; margin: 0;">
            🛡️ Екип на агенцията (${filteredUsers.length})
          </h3>
          ${isOwner ? `
            <button class="btn btn-primary btn-sm" onclick="window.app.openNewUserModal()">
              ➕ Нов член на екипа
            </button>
          ` : ''}
        </div>
        <div class="finance-table-wrapper">
          <table class="finance-table">
            <thead>
              <tr>
                <th>Име / Профил</th>
                <th>Потребителско име</th>
                ${isOwner ? '<th>Имейл</th>' : ''}
                <th>Роля и права</th>
                <th>Статус</th>
                ${isOwner ? '<th style="text-align: right;">Действия</th>' : ''}
              </tr>
            </thead>
            <tbody>
              ${filteredUsers.length === 0 ? `
                <tr>
                  <td colspan="${isOwner ? 6 : 4}" style="text-align: center; padding: 28px; color: #64748b;">
                    Няма намерени профили по зададения филтър.
                  </td>
                </tr>
              ` : filteredUsers.map(u => {
                const isSelf = u.userId === state.user?.userId;
                return `
                  <tr>
                    <td>
                      <div style="font-weight: 700; color: #0f172a;">
                        ${escapeHtml(u.displayName)}
                        ${isSelf ? `<span class="finance-badge badge-paid" style="margin-left: 6px; font-size: 11px;">Вие</span>` : ''}
                      </div>
                      <div style="font-size: 11px; color: #94a3b8;">Създаден: ${u.createdAt ? formatDate(u.createdAt) : '—'}</div>
                    </td>
                    <td><code>${escapeHtml(u.username || '—')}</code></td>
                    ${isOwner ? `<td style="font-size: 13px; color: #475569;">${escapeHtml(u.email || '—')}</td>` : ''}
                    <td>
                      ${isOwner ? `
                        <select class="form-control"
                                style="padding: 6px 10px; font-size: 13px; min-width: 210px; font-weight: 600;"
                                aria-label="Роля на ${escapeHtml(u.displayName)}"
                                onchange="window.app.handleQuickRoleChange('${escapeHtml(u.userId)}', this.value)">
                          ${renderRoleOptions(u.role)}
                        </select>
                      ` : `<strong>${getRoleLabel(u.role)}</strong>`}
                    </td>
                    <td>${renderUserStatusBadge(u.status)}</td>
                    ${isOwner ? `
                      <td style="text-align: right; white-space: nowrap;">
                        <button class="btn btn-secondary btn-sm" onclick="window.app.openEditUserModal('${escapeHtml(u.userId)}')">
                          ✏️ Редакция
                        </button>
                        ${u.status === 'active' && !isSelf ? `
                          <button class="btn btn-secondary btn-sm" style="color: #b91c1c; border-color: #fecaca; background: #fef2f2; margin-left: 6px;"
                                  onclick="window.app.handleDeactivateUser('${escapeHtml(u.userId)}')">
                            🚫 Спри достъп
                          </button>
                        ` : u.status !== 'active' ? `
                          <button class="btn btn-primary btn-sm" style="margin-left: 6px;"
                                  onclick="window.app.openEditUserModal('${escapeHtml(u.userId)}', true)">
                            ✅ Активирай
                          </button>
                        ` : ''}
                      </td>
                    ` : ''}
                  </tr>
                `;
              }).join('')}
            </tbody>
          </table>
        </div>
      </div>

      ${isOwner ? `
        <!-- Таблица: Клиенти по събития -->
        <div class="finance-table-card">
          <div class="card-header">
            <h3 style="font-size: 16px; font-weight: 700; color: #1e293b; margin: 0;">
              💌 Клиенти по събития (${filteredClients.length})
            </h3>
            <span style="font-size: 12px; color: #64748b;">Клиентите влизат без парола чрез персоналния си линк за събитието</span>
          </div>
          <div class="finance-table-wrapper">
            <table class="finance-table">
              <thead>
                <tr>
                  <th>Клиент</th>
                  <th>Имейл</th>
                  <th>Събитие</th>
                  <th>Бюджет в портала</th>
                  <th>Статус</th>
                  <th style="text-align: right;">Клиентски линк</th>
                </tr>
              </thead>
              <tbody>
                ${filteredClients.length === 0 ? `
                  <tr>
                    <td colspan="6" style="text-align: center; padding: 28px; color: #64748b;">
                      Няма клиентски профили${q ? ' по зададения филтър' : ''}.
                    </td>
                  </tr>
                ` : filteredClients.map(c => {
                  const rawLink = c.clientLink || '';
                  const fullLink = rawLink.startsWith('http')
                    ? rawLink
                    : (rawLink ? `${window.location.origin}${rawLink.startsWith('/') ? '' : '/'}${rawLink}` : '');
                  return `
                    <tr>
                      <td><strong>${escapeHtml(c.displayName)}</strong></td>
                      <td style="font-size: 13px; color: #475569;">${escapeHtml(c.email || '—')}</td>
                      <td>
                        <button class="btn btn-secondary btn-sm" style="padding: 3px 9px; font-size: 12px;"
                                onclick="window.app.switchEvent('${escapeHtml(c.eventId)}')">
                          📅 ${escapeHtml(c.eventTitle)}
                        </button>
                      </td>
                      <td>${c.canViewBudget ? '<span class="finance-badge badge-paid">👁️ Вижда бюджет</span>' : '<span class="finance-badge badge-pending">🔒 Скрит бюджет</span>'}</td>
                      <td>${renderUserStatusBadge(c.status)}</td>
                      <td style="text-align: right; white-space: nowrap;">
                        ${fullLink ? `
                          <button class="btn btn-secondary btn-sm" onclick="window.app.copyClientLink('${escapeHtml(fullLink)}')">
                            🔗 Копирай
                          </button>
                          <button class="btn btn-secondary btn-sm" style="margin-left: 6px;" onclick="window.open('${escapeHtml(fullLink)}', '_blank')">
                            👁️ Отвори
                          </button>
                        ` : '—'}
                      </td>
                    </tr>
                  `;
                }).join('')}
              </tbody>
            </table>
          </div>
        </div>
      ` : ''}
    `;
  }

  // ─── 3. Client Portal (Страница за клиента: само решения и проследяване) ────

  function renderClientPortal() {
    const data = state.clientAccess;
    const event = data.event;
    const client = data.client;
    const milestones = data.milestones || [];
    const proposals = data.proposals || [];
    const documents = data.documents || [];
    const budget = data.budget;

    // Намиране на следващия срок
    const nextMilestone = milestones.find(m => m.status !== 'confirmed') || milestones[0];

    // Намиране на чакащо решение
    const pendingProposal = proposals.find(p => p.active_request_id && !p.response);

    return `
      <div class="app-container" style="max-width: 960px; margin: 32px auto; padding: 0 20px;">
        <!-- Клиентски Header -->
        <div class="client-portal-header">
          <div style="display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 12px;">
            <div>
              <div style="font-size: 13px; font-weight: 700; color: #b8d8c0; text-transform: uppercase; letter-spacing: 1px; margin-bottom: 6px;">
                ${escapeHtml(event.agencyName || 'SaZa Events')} &bull; Клиентски портал
              </div>
              <h1>${escapeHtml(event.title)}</h1>
              <div class="client-meta-row">
                <div class="client-meta-item">📅 ${formatDate(event.startsAt)}</div>
                ${event.venueLabel ? `<div class="client-meta-item">📍 ${escapeHtml(event.venueLabel)}</div>` : ''}
                <div class="client-meta-item">👋 Здравейте, ${escapeHtml(client.name)}!</div>
              </div>
            </div>
            <div style="background: rgba(255, 255, 255, 0.1); backdrop-filter: blur(8px); padding: 8px 16px; border-radius: 20px; font-size: 13px; font-weight: 700;">
              Всичко е по план ✓
            </div>
          </div>
        </div>

        <!-- 4-те Ключови въпроса (Обзор) -->
        <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(210px, 1fr)); gap: 16px; margin-bottom: 32px;">
          <!-- 1. Статус -->
          <div class="card" style="padding: 20px; border-top: 3px solid #1e4d2b;">
            <div style="font-size: 12px; font-weight: 700; color: #64748b; text-transform: uppercase;">1. Ход на организацията</div>
            <div style="font-size: 18px; font-weight: 800; color: #1e4d2b; margin: 8px 0;">Всичко е по план</div>
            <div style="font-size: 13px; color: #64748b;">Няма забавяния в графика.</div>
          </div>

          <!-- 2. Следващ срок -->
          <div class="card" style="padding: 20px; border-top: 3px solid #2563eb;">
            <div style="font-size: 12px; font-weight: 700; color: #64748b; text-transform: uppercase;">2. Следващ важен срок</div>
            <div style="font-size: 15px; font-weight: 800; color: #0f172a; margin: 8px 0;">
              ${nextMilestone ? escapeHtml(nextMilestone.title) : 'Всички етапи са завършени'}
            </div>
            <div style="font-size: 13px; color: #64748b;">
              ${nextMilestone ? `Срок: ${formatDate(nextMilestone.due_date)}` : ''}
            </div>
          </div>

          <!-- 3. Действие от клиента -->
          <div class="card" style="padding: 20px; border-top: 3px solid ${pendingProposal ? '#f59e0b' : '#1e4d2b'};">
            <div style="font-size: 12px; font-weight: 700; color: #64748b; text-transform: uppercase;">3. Чака ли се действие от Вас?</div>
            <div style="font-size: 15px; font-weight: 800; color: ${pendingProposal ? '#d97706' : '#1e4d2b'}; margin: 8px 0;">
              ${pendingProposal ? '⚡ Очаква се избор' : '✓ Няма чакащи задачи'}
            </div>
            <div style="font-size: 13px; color: #64748b;">
              ${pendingProposal ? 'Имате подготвени варианти за одобрение по-долу.' : 'Агенцията работи по следващите задачи.'}
            </div>
          </div>

          <!-- 4. Финанси (ако има право) -->
          ${budget ? `
            <div class="card" style="padding: 20px; border-top: 3px solid #6366f1;">
              <div style="font-size: 12px; font-weight: 700; color: #64748b; text-transform: uppercase;">4. Финансов статус</div>
              <div style="font-size: 18px; font-weight: 800; color: #0f172a; margin: 8px 0;">${formatEUR(budget.totalCents)}</div>
              <div style="font-size: 13px; color: #64748b;">Платено: ${formatEUR(budget.paidCents)}</div>
            </div>
          ` : ''}
        </div>

        <!-- СЕКЦИЯ 1: ВЗЕМАНЕ НА РЕШЕНИЯ (Оферти и Варианти) -->
        <div style="margin-bottom: 36px;">
          <h2 style="font-size: 20px; font-weight: 800; margin-bottom: 16px; display: flex; align-items: center; gap: 8px;">
            <span>⚡</span> Вземане на решения (${proposals.length})
          </h2>

          ${proposals.length === 0 ? `
            <div class="card" style="padding: 24px; text-align: center; color: #64748b;">
              В момента няма активни предложения, изискващи Вашия избор. Когато организаторът подготви варианти (напр. меню, украса, програма), те ще се появят тук.
            </div>
          ` : `
            <div style="display: flex; flex-direction: column; gap: 20px;">
              ${proposals.map(p => renderClientProposalCard(p)).join('')}
            </div>
          `}
        </div>

        <!-- СЕКЦИЯ 2: ГРАФИК И ЕТАПИ (Само публикуваните от организатора) -->
        <div style="margin-bottom: 36px;">
          <h2 style="font-size: 20px; font-weight: 800; margin-bottom: 16px; display: flex; align-items: center; gap: 8px;">
            <span>📋</span> График на организацията (${milestones.length})
          </h2>

          ${milestones.length === 0 ? `
            <div class="card" style="padding: 24px; text-align: center; color: #64748b;">
              Организаторът все още подготвя графика за Вашето събитие.
            </div>
          ` : `
            <div style="display: flex; flex-direction: column; gap: 12px;">
              ${milestones.map(m => `
                <div class="card" style="display: flex; justify-content: space-between; align-items: center; padding: 16px 20px;">
                  <div>
                    <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 4px;">
                      <strong style="font-size: 16px;">${escapeHtml(m.title)}</strong>
                      <span class="status-pill status-${m.status || 'planned'}">${escapeHtml(m.status || 'planned')}</span>
                    </div>
                    <div style="color: #64748b; font-size: 13px;">
                      <span>📅 Краен срок: <strong>${formatDate(m.due_date)}</strong></span> &bull; 
                      <span>Следваща стъпка: ${escapeHtml(m.next_step || 'В процес')}</span>
                    </div>
                  </div>
                </div>
              `).join('')}
            </div>
          `}
        </div>

        <!-- СЕКЦИЯ 3: ДОКУМЕНТИ -->
        <div style="margin-bottom: 40px;">
          <h2 style="font-size: 20px; font-weight: 800; margin-bottom: 16px; display: flex; align-items: center; gap: 8px;">
            <span>📁</span> Споделени документи (${documents.length})
          </h2>

          ${documents.length === 0 ? `
            <div class="card" style="padding: 24px; text-align: center; color: #64748b;">
              Все още няма споделени документи.
            </div>
          ` : `
            <div style="display: flex; flex-direction: column; gap: 10px;">
              ${documents.map(d => `
                <div class="card" style="display: flex; justify-content: space-between; align-items: center; padding: 14px 20px;">
                  <div>
                    <strong>${escapeHtml(d.title)}</strong>
                    <div style="color: #64748b; font-size: 13px; margin-top: 2px;">
                      <span>${escapeHtml(d.original_name)}</span> &bull; 
                      <span>${escapeHtml(d.category)}</span> &bull; 
                      <span>${(d.byte_size / 1024).toFixed(1)} KB</span>
                    </div>
                  </div>
                  <button class="btn btn-secondary btn-sm" onclick="window.app.downloadDoc('${d.id}')">
                    ⬇️ Изтегли
                  </button>
                </div>
              `).join('')}
            </div>
          `}
        </div>

        <footer style="text-align: center; color: #94a3b8; font-size: 13px; padding: 24px 0;">
          Saza Event Portal &bull; Система за управление на събития
        </footer>
      </div>
    `;
  }

  function renderClientProposalCard(p) {
    const isDecided = !!p.response;
    const selectedOption = isDecided ? p.options?.find(o => o.id === p.response.selected_option_id) : null;

    if (isDecided) {
      return `
        <div class="card" style="padding: 24px; border-left: 4px solid #1e4d2b;">
          <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px; flex-wrap: wrap; gap: 8px;">
            <h3 style="font-size: 18px; font-weight: 800;">${escapeHtml(p.title)}</h3>
            <span style="background: #e3f0e6; color: #143d22; padding: 4px 12px; border-radius: 20px; font-weight: 700; font-size: 13px;">
              ✓ Одобрено от Вас
            </span>
          </div>
          <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin-bottom: 12px;">
            <div style="font-weight: 700; font-size: 16px; color: #0f172a; margin-bottom: 4px;">
              Избран вариант: ${escapeHtml(selectedOption?.title || 'Одобрен вариант')}
            </div>
            <p style="color: #64748b; font-size: 14px;">${escapeHtml(selectedOption?.description || '')}</p>
            ${selectedOption?.total_cents ? `<div style="font-weight: 700; color: #2563eb; margin-top: 6px;">${formatEUR(selectedOption.total_cents)}</div>` : ''}
          </div>
          ${p.response.comment ? `
            <div style="color: #475569; font-size: 13px;">Вашата бележка: "${escapeHtml(p.response.comment)}"</div>
          ` : ''}
        </div>
      `;
    }

    // Чакащо решение
    return `
      <div class="card" style="padding: 24px; border-left: 4px solid #f59e0b;">
        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 14px; flex-wrap: wrap; gap: 8px;">
          <div>
            <span style="font-size: 12px; font-weight: 700; color: #d97706; text-transform: uppercase;">Изисква се Вашето решение</span>
            <h3 style="font-size: 18px; font-weight: 800; margin-top: 2px;">${escapeHtml(p.title)}</h3>
          </div>
          <span style="background: #fef3c7; color: #92400e; padding: 4px 12px; border-radius: 20px; font-weight: 700; font-size: 13px;">
            Чака избор
          </span>
        </div>

        <p style="color: #64748b; font-size: 14px; margin-bottom: 16px;">
          Моля, изберете предпочитания вариант по-долу и потвърдете решението си:
        </p>

        <!-- Варианти за избор -->
        <div style="display: flex; flex-direction: column; gap: 10px; margin-bottom: 20px;">
          ${(p.options || []).map((opt, idx) => `
            <label style="border: 2px solid ${state.selectedOptionId === opt.id || (!state.selectedOptionId && idx === 0) ? '#2563eb' : '#e2e8f0'};
                          background: ${state.selectedOptionId === opt.id || (!state.selectedOptionId && idx === 0) ? '#eff6ff' : '#ffffff'};
                          padding: 16px; border-radius: 10px; cursor: pointer; display: flex; align-items: flex-start; gap: 12px; transition: all 0.2s ease;">
              <input type="radio" name="option_${p.id}" value="${opt.id}"
                     ${state.selectedOptionId === opt.id || (!state.selectedOptionId && idx === 0) ? 'checked' : ''}
                     onchange="window.app.selectOption('${opt.id}')"
                     style="margin-top: 4px;" />
              <div style="flex: 1;">
                <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px;">
                  <strong style="font-size: 15px; color: #0f172a;">${escapeHtml(opt.title)}</strong>
                  ${opt.total_cents ? `<span style="font-weight: 700; color: #2563eb;">${formatEUR(opt.total_cents)}</span>` : ''}
                </div>
                <p style="color: #64748b; font-size: 13px; line-height: 1.4;">${escapeHtml(opt.description || 'Няма допълнително описание')}</p>
              </div>
            </label>
          `).join('')}
        </div>

        <div style="margin-bottom: 16px;">
          <label style="display: block; font-size: 13px; font-weight: 600; margin-bottom: 6px; color: #334155;">Ваш коментар или указание (незадължително)</label>
          <input type="text" id="decision-comment-${p.id}" class="form-control" placeholder="напр. Предпочитаме вариант 1 с лека промяна в часовете..." />
        </div>

        <div style="display: flex; gap: 12px; flex-wrap: wrap;">
          <button class="btn btn-primary" onclick="window.app.submitDecision('${p.active_request_id}', 'approved', '${p.id}')" style="padding: 10px 20px; font-weight: 700;">
            ✓ Одобрявам този избор
          </button>
          <button class="btn btn-secondary" onclick="window.app.submitDecision('${p.active_request_id}', 'changes_requested', '${p.id}')" style="padding: 10px 20px;">
            ✏️ Искам промени
          </button>
        </div>
      </div>
    `;
  }

  // ─── Модални прозорци ────────────────────────────────────────────────────────

  function renderNewEventModal() {
    return `
      <div class="modal-backdrop" onclick="if (event.target === this) window.app.closeModal()">
        <div class="modal-box" style="max-width: 520px;">
          <div class="modal-header">
            <h3>➕ Създаване на ново събитие</h3>
            <button class="modal-close" onclick="window.app.closeModal()">&times;</button>
          </div>
          <form onsubmit="window.app.handleCreateEvent(event)">
            <div class="form-group">
              <label>Име на събитието *</label>
              <input type="text" name="title" class="form-control" placeholder="напр. Сватба на Мария и Георги" required autofocus />
            </div>

            <div style="display: flex; gap: 12px;">
              <div class="form-group" style="flex: 1;">
                <label>Тип събитие</label>
                <select name="eventType" class="form-control">
                  <option value="wedding">Сватба</option>
                  <option value="corporate">Корпоративно събитие</option>
                  <option value="personal">Рожден ден / Юбилей</option>
                  <option value="other">Друго</option>
                </select>
              </div>
              <div class="form-group" style="flex: 1;">
                <label>Дата на събитието</label>
                <input type="date" name="startsAt" class="form-control" value="${new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10)}" required />
              </div>
            </div>

            <div class="form-group">
              <label>Локация / Зала</label>
              <input type="text" name="venueLabel" class="form-control" placeholder="напр. Резиденция Тера, София" />
            </div>

            <hr style="border: 0; border-top: 1px solid #e2e8f0; margin: 16px 0;" />

            <div style="display: flex; gap: 12px;">
              <div class="form-group" style="flex: 1;">
                <label>Име на клиента</label>
                <input type="text" name="clientName" class="form-control" placeholder="напр. Мария Иванова" required />
              </div>
              <div class="form-group" style="flex: 1;">
                <label>Имейл на клиента</label>
                <input type="email" name="clientEmail" class="form-control" placeholder="maria@example.com" required />
              </div>
            </div>

            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 20px;">
              <input type="checkbox" id="canViewBudget" name="canViewBudget" checked />
              <label for="canViewBudget" style="font-size: 13px; cursor: pointer;">Разреши на клиента да вижда бюджета и плащанията</label>
            </div>

            <div style="display: flex; justify-content: flex-end; gap: 10px;">
              <button type="button" class="btn btn-secondary" onclick="window.app.closeModal()">Отказ</button>
              <button type="submit" class="btn btn-primary">Създай и генерирай линк</button>
            </div>
          </form>
        </div>
      </div>
    `;
  }

  function renderNewMilestoneModal() {
    return `
      <div class="modal-backdrop" onclick="if (event.target === this) window.app.closeModal()">
        <div class="modal-box" style="max-width: 480px;">
          <div class="modal-header">
            <h3>➕ Добавяне на нов етап</h3>
            <button class="modal-close" onclick="window.app.closeModal()">&times;</button>
          </div>
          <form onsubmit="window.app.handleCreateMilestone(event)">
            <div class="form-group">
              <label>Заглавие на етапа *</label>
              <input type="text" name="title" class="form-control" placeholder="напр. Избор на сватбена торта" required autofocus />
            </div>

            <div style="display: flex; gap: 12px;">
              <div class="form-group" style="flex: 1;">
                <label>Категория</label>
                <select name="category" class="form-control">
                  <option value="Локация">Локация</option>
                  <option value="Декорация">Декорация</option>
                  <option value="Кетъринг">Кетъринг</option>
                  <option value="Музика и Програма">Музика и Програма</option>
                  <option value="Фото и Видео">Фото и Видео</option>
                  <option value="Организация">Организация</option>
                </select>
              </div>
              <div class="form-group" style="flex: 1;">
                <label>Краен срок</label>
                <input type="date" name="dueDate" class="form-control" value="${new Date(Date.now() + 14 * 86400000).toISOString().slice(0, 10)}" required />
              </div>
            </div>

            <div class="form-group">
              <label>Следваща стъпка / Описание за клиента</label>
              <input type="text" name="nextStep" class="form-control" placeholder="напр. Изпращане на мостри за дегустация" />
            </div>

            <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 20px;">
              <input type="checkbox" id="isPublished" name="isPublished" checked />
              <label for="isPublished" style="font-size: 13px; cursor: pointer;">Публикувай веднага за клиента (видим в клиентския портал)</label>
            </div>

            <div style="display: flex; justify-content: flex-end; gap: 10px;">
              <button type="button" class="btn btn-secondary" onclick="window.app.closeModal()">Отказ</button>
              <button type="submit" class="btn btn-primary">Запази етапа</button>
            </div>
          </form>
        </div>
      </div>
    `;
  }

  function renderNewProposalModal() {
    return `
      <div class="modal-backdrop" onclick="if (event.target === this) window.app.closeModal()">
        <div class="modal-box" style="max-width: 540px;">
          <div class="modal-header">
            <h3>⚡ Ново предложение за избор от клиента</h3>
            <button class="modal-close" onclick="window.app.closeModal()">&times;</button>
          </div>
          <form onsubmit="window.app.handleCreateProposal(event)">
            <div class="form-group">
              <label>Относно / Заглавие *</label>
              <input type="text" name="title" class="form-control" placeholder="напр. Избор на празнично меню" required autofocus />
            </div>

            <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px; margin-bottom: 16px;">
              <strong style="display: block; font-size: 14px; margin-bottom: 8px; color: #1e293b;">Вариант 1</strong>
              <div style="display: flex; gap: 10px; margin-bottom: 8px;">
                <input type="text" name="opt1_title" class="form-control" placeholder="Заглавие: напр. Средиземноморско меню" required style="flex: 2;" />
                <input type="number" name="opt1_price" class="form-control" placeholder="Цена в EUR" value="75" required style="flex: 1;" />
              </div>
              <input type="text" name="opt1_desc" class="form-control" placeholder="Описание: Телешко филе, лаврак, салата..." />
            </div>

            <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 14px; margin-bottom: 20px;">
              <strong style="display: block; font-size: 14px; margin-bottom: 8px; color: #1e293b;">Вариант 2</strong>
              <div style="display: flex; gap: 10px; margin-bottom: 8px;">
                <input type="text" name="opt2_title" class="form-control" placeholder="Заглавие: напр. Традиционно гурме" required style="flex: 2;" />
                <input type="number" name="opt2_price" class="form-control" placeholder="Цена в EUR" value="82" required style="flex: 1;" />
              </div>
              <input type="text" name="opt2_desc" class="form-control" placeholder="Описание: Патешко магре, сьомга, десерт..." />
            </div>

            <div style="display: flex; justify-content: flex-end; gap: 10px;">
              <button type="button" class="btn btn-secondary" onclick="window.app.closeModal()">Отказ</button>
              <button type="submit" class="btn btn-primary">Създай и изпрати за решение</button>
            </div>
          </form>
        </div>
      </div>
    `;
  }

  function renderNewPaymentModal() {
    const events = state.events || [];
    const selectedId = state.selectedEventForModal || state.currentEventId;
    const todayStr = new Date().toISOString().slice(0, 10);

    return `
      <div class="modal-backdrop" onclick="if(event.target === this) window.app.closeModal()">
        <div class="modal-box" style="max-width: 480px;">
          <div class="modal-header">
            <h3>💳 Записване на плащане от клиент</h3>
            <button class="modal-close" onclick="window.app.closeModal()">&times;</button>
          </div>
          <form onsubmit="window.app.handleCreatePayment(event)">
            <div class="form-group">
              <label>Изберете събитие *</label>
              <select name="eventId" class="form-control" required>
                ${events.map(ev => `
                  <option value="${ev.id}" ${ev.id === selectedId ? 'selected' : ''}>${escapeHtml(ev.title)}</option>
                `).join('')}
              </select>
            </div>

            <div class="form-group">
              <label>Сума в EUR (€) *</label>
              <input type="number" step="0.01" min="1" name="amountEUR" class="form-control" placeholder="напр. 1500.00" required autofocus />
            </div>

            <div class="form-group">
              <label>Дата на плащането *</label>
              <input type="date" name="effectiveDate" class="form-control" value="${todayStr}" required />
            </div>

            <div class="form-group">
              <label>Основание / Бележка</label>
              <input type="text" name="reference" class="form-control" placeholder="напр. Капаро по банков път, вноска 2" />
            </div>

            <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px;">
              <button type="button" class="btn btn-secondary" onclick="window.app.closeModal()">Отказ</button>
              <button type="submit" class="btn btn-primary">💾 Запиши плащането</button>
            </div>
          </form>
        </div>
      </div>
    `;
  }

  function renderNewBudgetItemModal() {
    const events = state.events || [];
    const selectedId = state.selectedEventForModal || state.currentEventId;

    return `
      <div class="modal-backdrop" onclick="if(event.target === this) window.app.closeModal()">
        <div class="modal-box" style="max-width: 540px;">
          <div class="modal-header">
            <h3>🧾 Ново перо в бюджета на събитието</h3>
            <button class="modal-close" onclick="window.app.closeModal()">&times;</button>
          </div>
          <form onsubmit="window.app.handleCreateBudgetItem(event)">
            <div class="form-group">
              <label>Изберете събитие *</label>
              <select name="eventId" class="form-control" required>
                ${events.map(ev => `
                  <option value="${ev.id}" ${ev.id === selectedId ? 'selected' : ''}>${escapeHtml(ev.title)}</option>
                `).join('')}
              </select>
            </div>

            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
              <div class="form-group">
                <label>Категория *</label>
                <select name="category" class="form-control" required>
                  <option value="Локация / Наем">Локация / Наем</option>
                  <option value="Кетъринг & Напитки">Кетъринг & Напитки</option>
                  <option value="Декорация & Флористика">Декорация & Флористика</option>
                  <option value="Музика, DJ & Озвучаване">Музика, DJ & Озвучаване</option>
                  <option value="Фото & Видеозаснемане">Фото & Видеозаснемане</option>
                  <option value="Водещ / Шоу програми">Водещ / Шоу програми</option>
                  <option value="Организационна такса">Организационна такса</option>
                  <option value="Логистика & Транспорт">Логистика & Транспорт</option>
                  <option value="Други разходи">Други разходи</option>
                </select>
              </div>

              <div class="form-group">
                <label>Цена за клиента (€) *</label>
                <input type="number" step="0.01" min="0" name="totalEUR" class="form-control" placeholder="напр. 2500.00" required />
              </div>
            </div>

            <div class="form-group">
              <label>Описание за клиента *</label>
              <input type="text" name="description" class="form-control" placeholder="напр. Цялостна украса, сватбена арка и цветни аранжировки" required />
            </div>

            <div style="padding: 12px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 6px; margin-bottom: 16px;">
              <div style="font-size: 12px; font-weight: 700; color: #475569; text-transform: uppercase; margin-bottom: 8px;">
                🔒 Вътрешни разходи за агенцията (Скрити от клиента)
              </div>
              <div style="display: grid; grid-template-columns: 1.5fr 1fr; gap: 10px;">
                <div>
                  <label style="font-size: 12px; font-weight: 600;">Подизпълнител / Доставчик</label>
                  <input type="text" name="supplierName" class="form-control" placeholder="напр. Флорист Ателие ЕООД" />
                </div>
                <div>
                  <label style="font-size: 12px; font-weight: 600;">Разход (€)</label>
                  <input type="number" step="0.01" min="0" name="supplierCostEUR" class="form-control" placeholder="напр. 1600.00" />
                </div>
              </div>
              <div style="margin-top: 8px;">
                <label style="font-size: 12px; font-weight: 600;">Вътрешна бележка</label>
                <input type="text" name="note" class="form-control" placeholder="напр. Договорена отстъпка с доставчика" />
              </div>
            </div>

            <div style="display: flex; justify-content: flex-end; gap: 10px;">
              <button type="button" class="btn btn-secondary" onclick="window.app.closeModal()">Отказ</button>
              <button type="submit" class="btn btn-primary">💾 Добави в бюджета</button>
            </div>
          </form>
        </div>
      </div>
    `;
  }

  function renderNewScheduleModal() {
    const events = state.events || [];
    const selectedId = state.selectedEventForModal || state.currentEventId;

    return `
      <div class="modal-backdrop" onclick="if(event.target === this) window.app.closeModal()">
        <div class="modal-box" style="max-width: 480px;">
          <div class="modal-header">
            <h3>📅 Нова вноска в графика на плащанията</h3>
            <button class="modal-close" onclick="window.app.closeModal()">&times;</button>
          </div>
          <form onsubmit="window.app.handleCreateSchedule(event)">
            <div class="form-group">
              <label>Изберете събитие *</label>
              <select name="eventId" class="form-control" required>
                ${events.map(ev => `
                  <option value="${ev.id}" ${ev.id === selectedId ? 'selected' : ''}>${escapeHtml(ev.title)}</option>
                `).join('')}
              </select>
            </div>

            <div class="form-group">
              <label>Етикет на вноската *</label>
              <input type="text" name="label" class="form-control" placeholder="напр. Капаро 30% при подписване" required autofocus />
            </div>

            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
              <div class="form-group">
                <label>Сума в EUR (€) *</label>
                <input type="number" step="0.01" min="1" name="amountEUR" class="form-control" placeholder="напр. 2000.00" required />
              </div>

              <div class="form-group">
                <label>Падежна дата *</label>
                <input type="date" name="dueDate" class="form-control" required />
              </div>
            </div>

            <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px;">
              <button type="button" class="btn btn-secondary" onclick="window.app.closeModal()">Отказ</button>
              <button type="submit" class="btn btn-primary">💾 Запиши вноската</button>
            </div>
          </form>
        </div>
      </div>
    `;
  }

  function renderUserModal() {
    const modal = state.userModal;
    if (!modal) return '';

    const isEdit = modal.mode === 'edit' && modal.user;
    const u = modal.user || {};
    const initialStatus = modal.forceActivate ? 'active' : (u.status || 'active');
    const requirePassword = !isEdit || u.status === 'revoked';

    return `
      <div class="modal-backdrop" onclick="if(event.target === this) window.app.closeModal()">
        <div class="modal-box" style="max-width: 520px;">
          <div class="modal-header">
            <h3>${isEdit ? `✏️ Редакция на профил: ${escapeHtml(u.displayName)}` : '👤 Добавяне на нов профил в екипа'}</h3>
            <button class="modal-close" onclick="window.app.closeModal()">&times;</button>
          </div>

          <form onsubmit="window.app.handleSaveUser(event)">
            <div class="form-group">
              <label>Пълно име *</label>
              <input type="text" name="displayName" class="form-control"
                     value="${isEdit ? escapeHtml(u.displayName || '') : ''}"
                     placeholder="напр. Мария Иванова" required autofocus />
            </div>

            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px;">
              <div class="form-group">
                <label>Потребителско име ${isEdit ? '' : '*'}</label>
                ${isEdit ? `
                  <input type="text" class="form-control" value="${escapeHtml(u.username || '')}" disabled
                         style="background: #f1f5f9; color: #64748b;" />
                ` : `
                  <input type="text" name="username" class="form-control"
                         placeholder="напр. MIvanova" required autocomplete="off" />
                `}
              </div>

              <div class="form-group">
                <label>Имейл *</label>
                <input type="email" name="email" class="form-control"
                       value="${isEdit ? escapeHtml(u.email || '') : ''}"
                       placeholder="name@sandurek.com" required />
              </div>
            </div>

            <div style="display: grid; grid-template-columns: ${isEdit ? '1fr 1fr' : '1fr'}; gap: 12px;">
              <div class="form-group">
                <label>Роля в агенцията *</label>
                <select name="role" class="form-control" required>
                  ${renderRoleOptions(isEdit ? u.role : 'coordinator')}
                </select>
              </div>

              ${isEdit ? `
                <div class="form-group">
                  <label>Статус на достъпа *</label>
                  <select name="status" class="form-control" required>
                    <option value="active" ${initialStatus === 'active' ? 'selected' : ''}>🟢 Активен</option>
                    <option value="suspended" ${initialStatus === 'suspended' ? 'selected' : ''}>⏸️ Временно спрян</option>
                    <option value="revoked" ${initialStatus === 'revoked' ? 'selected' : ''}>🚫 Деактивиран</option>
                  </select>
                </div>
              ` : ''}
            </div>

            <div class="form-group">
              <label>${isEdit
                ? (requirePassword ? 'Нова парола за активиране (мин. 6 символа) *' : 'Нова парола (оставете празно без промяна)')
                : 'Парола за вход (мин. 6 символа) *'}</label>
              <input type="password" name="password" class="form-control" minlength="6"
                     autocomplete="new-password"
                     placeholder="${isEdit ? '•••••• (по избор)' : 'Минимум 6 символа'}"
                     ${requirePassword ? 'required' : ''} />
            </div>

            <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 12px; margin-bottom: 16px; font-size: 12px; color: #475569; line-height: 1.55;">
              ${AGENCY_ROLE_OPTIONS.map(r => `
                <div><strong>${r.label}:</strong> ${r.description}</div>
              `).join('')}
            </div>

            <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 16px;">
              <button type="button" class="btn btn-secondary" onclick="window.app.closeModal()">Отказ</button>
              <button type="submit" class="btn btn-primary">
                ${isEdit ? '💾 Запази промените' : '➕ Създай профил'}
              </button>
            </div>
          </form>
        </div>
      </div>
    `;
  }

  // ─── Публичен App Обект (Event Handlers) ───────────────────────────────────

  window.app = {
    async handleLogin(e) {
      e.preventDefault();
      const usernameInput = document.getElementById('username');
      const passwordInput = document.getElementById('password');
      const errorDiv = document.getElementById('login-error-msg');
      const submitBtn = document.getElementById('login-submit-btn');

      if (errorDiv) errorDiv.style.display = 'none';
      if (submitBtn) submitBtn.disabled = true;

      try {
        const res = await apiFetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            username: usernameInput.value.trim(),
            password: passwordInput.value,
          }),
        });

        state.user = res.user;
        state.currentView = 'dashboard';
        showToast(`Добре дошли отново, ${state.user.displayName}!`);
        await loadStaffEvents();
        await loadFinancesOverview();
        await loadUsers();
        render();
      } catch (err) {
        if (errorDiv) {
          errorDiv.textContent = err.message || 'Невалидно потребителско име или парола';
          errorDiv.style.display = 'block';
        }
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    },

    async handleLogout() {
      try {
        await apiFetch('/api/auth/logout', { method: 'POST' });
      } catch {}
      state.user = null;
      state.events = [];
      state.currentEventId = null;
      state.currentEventDetails = null;
      state.financesData = null;
      state.users = [];
      state.clients = [];
      state.userSearch = '';
      state.eventSearch = '';
      state.eventTypeFilter = 'all';
      state.userModal = null;
      state.currentView = 'events';
      render();
    },

    openNewEventModal() {
      openModalWith(() => { state.isNewEventModalOpen = true; });
    },

    openNewMilestoneModal() {
      openModalWith(() => { state.isNewMilestoneModalOpen = true; });
    },

    openNewProposalModal() {
      openModalWith(() => { state.isNewProposalModalOpen = true; });
    },

    switchView(view) {
      state.currentView = view;
      state.isSidebarOpen = false;
      if (view === 'finances' || view === 'dashboard') {
        loadFinancesOverview().then(() => render());
      } else if (view === 'users') {
        loadUsers().then(() => render());
      } else if (view === 'events') {
        render();
        loadStaffEvents().then(() => render());
      } else {
        render();
      }
    },

    switchEventTab(tab) {
      state.currentView = 'event-detail';
      state.activeTab = tab;
      state.isSidebarOpen = false;
      render();
    },

    toggleSidebar() {
      state.isSidebarOpen = !state.isSidebarOpen;
      render();
    },

    viewEventFinances(eventId) {
      state.currentEventId = eventId;
      state.currentView = 'event-detail';
      state.activeTab = 'finances';
      state.isSidebarOpen = false;
      loadEventDetails(eventId).then(() => render());
    },

    async refreshEvents() {
      await loadStaffEvents();
      showToast('Списъкът със събития е обновен!');
      render();
    },

    setEventSearch(q) {
      preserveInputFocus('events-search-input', () => {
        state.eventSearch = q;
      });
    },

    setEventTypeFilter(eventType) {
      state.eventTypeFilter = eventType || 'all';
      render();
    },

    async handleDeleteEvent(eventId) {
      const targetEvent = (state.events || []).find(ev => ev.id === eventId)
        || (state.currentEventDetails?.id === eventId ? state.currentEventDetails : null);
      const label = targetEvent?.title || eventId;
      if (!confirm(`Сигурни ли сте, че искате да изтриете събитието "${label}"?\nВсички етапи, оферти, документи, бюджети и плащания по него ще бъдат премахнати завинаги.`)) {
        return;
      }

      try {
        await apiFetch(`/api/events/${encodeURIComponent(eventId)}`, {
          method: 'DELETE',
        });
        if (state.currentEventId === eventId) {
          state.currentEventId = null;
          state.currentEventDetails = null;
          if (state.currentView === 'event-detail') {
            state.currentView = 'events';
          }
        }
        showToast(`Събитието "${label}" е изтрито успешно!`);
        await loadStaffEvents();
        await loadFinancesOverview();
        await loadUsers();
        render();
      } catch (err) {
        showToast(err.message, 'error');
      }
    },

    async submitOwnerDecision(requestId, selectedOptionId, optionTitle) {
      try {
        await apiFetch(`/api/proposals/${encodeURIComponent(requestId)}/respond`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            decision: 'approved',
            selectedOptionId,
            comment: `Одобрено от Собственик: ${optionTitle || selectedOptionId}`,
          }),
        });
        showToast(`Вариант "${optionTitle}" е одобрен успешно!`);
        if (state.currentEventId) {
          await loadEventDetails(state.currentEventId);
        }
        render();
      } catch (err) {
        showToast(err.message, 'error');
      }
    },

    openNewPaymentModal(eventId) {
      openModalWith(() => {
        state.selectedEventForModal = eventId || state.currentEventId;
        state.isNewPaymentModalOpen = true;
      });
    },

    openNewBudgetItemModal(eventId) {
      openModalWith(() => {
        state.selectedEventForModal = eventId || state.currentEventId;
        state.isNewBudgetItemModalOpen = true;
      });
    },

    openNewScheduleModal(eventId) {
      openModalWith(() => {
        state.selectedEventForModal = eventId || state.currentEventId;
        state.isNewScheduleModalOpen = true;
      });
    },

    async refreshFinances() {
      await loadFinancesOverview();
      if (state.currentEventId) {
        await loadEventDetails(state.currentEventId);
      }
      showToast('Финансовите данни са обновени успешно!');
      render();
    },

    openNewUserModal() {
      openModalWith(() => {
        state.userModal = { mode: 'create' };
      });
    },

    openEditUserModal(userId, forceActivate = false) {
      const targetUser = (state.users || []).find(u => u.userId === userId);
      if (!targetUser) return;
      openModalWith(() => {
        state.userModal = { mode: 'edit', user: targetUser, forceActivate };
      });
    },

    async refreshUsers() {
      await loadUsers();
      showToast('Списъкът с хора и профили е обновен!');
      render();
    },

    setUserSearch(q) {
      preserveInputFocus('users-search-input', () => {
        state.userSearch = q;
      });
    },

    async handleSaveUser(e) {
      e.preventDefault();
      const modal = state.userModal;
      if (!modal) return;
      const form = e.target;
      const submitBtn = form.querySelector('button[type="submit"]');
      if (submitBtn) submitBtn.disabled = true;

      try {
        if (modal.mode === 'create') {
          const payload = {
            displayName: form.displayName.value.trim(),
            username: form.username.value.trim(),
            email: form.email.value.trim(),
            role: form.role.value,
            password: form.password.value,
          };
          await apiFetch('/api/admin/users', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          showToast(`Профилът "${payload.displayName}" е създаден успешно!`);
        } else if (modal.mode === 'edit' && modal.user) {
          const userId = modal.user.userId;
          const payload = {
            displayName: form.displayName.value.trim(),
            email: form.email.value.trim(),
            role: form.role.value,
            status: form.status.value,
          };
          if (form.password.value) {
            payload.password = form.password.value;
          }
          await apiFetch(`/api/admin/users/${encodeURIComponent(userId)}`, {
            method: 'PATCH',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
          });
          if (userId === state.user?.userId && payload.role) {
            state.user.role = payload.role;
            state.user.displayName = payload.displayName || state.user.displayName;
          }
          showToast('Профилът и правата са обновени успешно!');
        }

        state.userModal = null;
        await loadUsers();
        await loadStaffEvents();
        render();
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    },

    async handleQuickRoleChange(userId, newRole) {
      const targetUser = (state.users || []).find(u => u.userId === userId);
      if (!targetUser || targetUser.role === newRole) return;

      try {
        await apiFetch(`/api/admin/users/${encodeURIComponent(userId)}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: newRole }),
        });
        if (userId === state.user?.userId) {
          state.user.role = newRole;
        }
        showToast(`Ролята на ${targetUser.displayName} е променена на ${getRoleLabel(newRole)}`);
        await loadUsers();
        await loadStaffEvents();
        render();
      } catch (err) {
        showToast(err.message, 'error');
        await loadUsers();
        render();
      }
    },

    async handleDeactivateUser(userId) {
      const targetUser = (state.users || []).find(u => u.userId === userId);
      const label = targetUser ? targetUser.displayName : userId;
      if (!confirm(`Сигурни ли сте, че искате да спрете достъпа на "${label}"?`)) {
        return;
      }

      try {
        await apiFetch(`/api/admin/users/${encodeURIComponent(userId)}`, {
          method: 'DELETE',
        });
        showToast(`Достъпът на ${label} е спрян.`);
        await loadUsers();
        render();
      } catch (err) {
        showToast(err.message, 'error');
      }
    },

    closeModal() {
      const backdrop = document.querySelector('.modal-backdrop');
      if (backdrop && backdrop.classList) {
        if (state._closingModalTimer) return;
        backdrop.classList.add('is-closing');
        state._closingModalTimer = setTimeout(() => {
          resetModalFlags();
          render();
        }, 150);
        return;
      }

      resetModalFlags();
      render();
    },

    async switchEvent(eventId) {
      state.currentEventId = eventId;
      state.currentView = 'event-detail';
      state.isSidebarOpen = false;
      await loadEventDetails(eventId);
      render();
    },

    switchTab(tab) {
      state.activeTab = tab;
      render();
    },

    selectOption(optId) {
      state.selectedOptionId = optId;
      render();
    },

    copyClientLink(link) {
      if (!link) {
        showToast('Няма наличен клиентски линк за това събитие', 'error');
        return;
      }
      navigator.clipboard.writeText(link).then(() => {
        showToast('Линкът за клиента е копиран в клипборда!');
      }).catch(() => {
        prompt('Копирайте линка за клиента:', link);
      });
    },

    async handleCreateEvent(e) {
      e.preventDefault();
      const form = e.target;
      const title = form.title.value.trim();
      const eventType = form.eventType.value;
      const startsAt = new Date(form.startsAt.value).toISOString();
      const venueLabel = form.venueLabel.value.trim();
      const clientName = form.clientName.value.trim();
      const clientEmail = form.clientEmail.value.trim();
      const canViewBudget = form.canViewBudget.checked;

      try {
        const res = await apiFetch('/api/events', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title,
            eventType,
            startsAt,
            venueLabel,
            clientName,
            clientEmail,
            canViewBudget,
          }),
        });

        state.isNewEventModalOpen = false;
        showToast('Събитието е създадено успешно!');
        state.currentEventId = res.eventId;
        state.currentView = 'event-detail';
        await loadStaffEvents();
        await loadFinancesOverview();
        await loadUsers();
        render();
      } catch (err) {
        showToast(err.message, 'error');
      }
    },

    async handleCreateMilestone(e) {
      e.preventDefault();
      const form = e.target;
      const title = form.title.value.trim();
      const category = form.category.value;
      const dueDate = form.dueDate.value;
      const nextStep = form.nextStep.value.trim();
      const isPublished = form.isPublished.checked;

      try {
        await apiFetch(`/api/events/${state.currentEventId}/milestones`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title, category, dueDate, nextStep, isPublished }),
        });

        state.isNewMilestoneModalOpen = false;
        showToast('Етапът е добавен успешно!');
        await loadEventDetails(state.currentEventId);
        render();
      } catch (err) {
        showToast(err.message, 'error');
      }
    },

    async handleCreateProposal(e) {
      e.preventDefault();
      const form = e.target;
      const title = form.title.value.trim();
      const opt1Title = form.opt1_title.value.trim();
      const opt1Price = parseFloat(form.opt1_price.value || '0') * 100;
      const opt1Desc = form.opt1_desc.value.trim();

      const opt2Title = form.opt2_title.value.trim();
      const opt2Price = parseFloat(form.opt2_price.value || '0') * 100;
      const opt2Desc = form.opt2_desc.value.trim();

      try {
        await apiFetch(`/api/events/${state.currentEventId}/proposals`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title,
            options: [
              { title: opt1Title, totalCents: opt1Price, description: opt1Desc },
              { title: opt2Title, totalCents: opt2Price, description: opt2Desc },
            ],
          }),
        });

        state.isNewProposalModalOpen = false;
        showToast('Предложението с варианти е изпратено за одобрение!');
        await loadEventDetails(state.currentEventId);
        render();
      } catch (err) {
        showToast(err.message, 'error');
      }
    },

    async handleCreatePayment(e) {
      e.preventDefault();
      const form = e.target;
      const eventId = form.eventId.value;
      const amountEUR = form.amountEUR.value;
      const effectiveDate = form.effectiveDate.value;
      const reference = form.reference.value.trim();

      try {
        await apiFetch(`/api/events/${eventId}/payments`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ amountEUR, effectiveDate, reference }),
        });

        state.isNewPaymentModalOpen = false;
        showToast('Плащането е записано успешно!');
        await loadFinancesOverview();
        if (state.currentEventId === eventId) {
          await loadEventDetails(eventId);
        }
        render();
      } catch (err) {
        showToast(err.message, 'error');
      }
    },

    async handleCreateBudgetItem(e) {
      e.preventDefault();
      const form = e.target;
      const eventId = form.eventId.value;
      const category = form.category.value;
      const description = form.description.value.trim();
      const totalEUR = form.totalEUR.value;
      const supplierName = form.supplierName.value.trim();
      const supplierCostEUR = form.supplierCostEUR.value;
      const note = form.note.value.trim();

      try {
        await apiFetch(`/api/events/${eventId}/budget-items`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ category, description, totalEUR, supplierName, supplierCostEUR, note }),
        });

        state.isNewBudgetItemModalOpen = false;
        showToast('Перото е добавено в бюджета!');
        await loadFinancesOverview();
        if (state.currentEventId === eventId) {
          await loadEventDetails(eventId);
        }
        render();
      } catch (err) {
        showToast(err.message, 'error');
      }
    },

    async handleCreateSchedule(e) {
      e.preventDefault();
      const form = e.target;
      const eventId = form.eventId.value;
      const label = form.label.value.trim();
      const amountEUR = form.amountEUR.value;
      const dueDate = form.dueDate.value;

      try {
        await apiFetch(`/api/events/${eventId}/payment-schedules`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ label, amountEUR, dueDate }),
        });

        state.isNewScheduleModalOpen = false;
        showToast('Вноската е добавена в графика!');
        await loadFinancesOverview();
        if (state.currentEventId === eventId) {
          await loadEventDetails(eventId);
        }
        render();
      } catch (err) {
        showToast(err.message, 'error');
      }
    },

    async handleDocumentUpload(e) {
      e.preventDefault();
      const form = e.target;
      const submitBtn = form.querySelector('button[type="submit"]');
      const formData = new FormData(form);
      const isAudienceClient = form.audienceClient.checked;
      formData.set('audience', isAudienceClient ? 'client' : 'staff_only');

      if (submitBtn) submitBtn.disabled = true;
      try {
        const res = await fetch(`/api/events/${state.currentEventId}/documents/upload`, {
          method: 'POST',
          body: formData,
        });
        const data = await res.json().catch(() => ({}));
        if (!res.ok) {
          throw new Error(data.error?.message || `Грешка при качване (${res.status})`);
        }

        showToast('Файлът е качен успешно!');
        form.reset();
        await loadEventDetails(state.currentEventId);
        render();
      } catch (err) {
        showToast(err.message, 'error');
      } finally {
        if (submitBtn) submitBtn.disabled = false;
      }
    },

    downloadDoc(docId) {
      window.open(`/api/documents/${docId}/download`, '_blank');
    },

    async submitDecision(requestId, decision, proposalId) {
      const commentInput = document.getElementById(`decision-comment-${proposalId}`);
      const comment = commentInput ? commentInput.value.trim() : '';
      const checkedRadio = document.querySelector(`input[name="option_${proposalId}"]:checked`);
      const selectedOptionId = checkedRadio ? checkedRadio.value : state.selectedOptionId;

      try {
        await apiFetch(`/api/proposals/${requestId}/respond`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            decision,
            selectedOptionId,
            comment: comment || (decision === 'approved' ? 'Одобрено от клиента' : 'Искам промяна'),
          }),
        });

        state.selectedOptionId = null;
        showToast(decision === 'approved' ? 'Вашето одобрение е записано успешно!' : 'Вашето искане за промяна е изпратено!');

        // Презареждане на клиентския портал
        const accessData = await apiFetch(`/api/portal/access?token=${encodeURIComponent(state.clientToken)}`);
        state.clientAccess = accessData;
        render();
      } catch (err) {
        showToast(err.message, 'error');
      }
    },
  };

  // Стартиране на приложението
  window.addEventListener('DOMContentLoaded', init);
})();
