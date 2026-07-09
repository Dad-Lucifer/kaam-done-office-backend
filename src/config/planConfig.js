'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// Plan Configuration — Single Source of Truth
//
// These definitions are the canonical plan limits and permissions for the
// subscription enforcement system.
//
// To add a new plan:
//   1. Add a new entry to PLAN_DEFINITIONS below.
//   2. Ensure any new limit fields are also listed in RESOURCE_LIMIT_MAP.
//   3. No other file needs to change — all enforcement reads from here.
// ─────────────────────────────────────────────────────────────────────────────

const PLAN_DEFINITIONS = {
  free: {
    planId: 'free',
    planName: 'Free',
    price: 0,
    limits: {
      maxCategories:    2,
      maxTextChannels:  3,
      maxVoiceChannels: 1,
      maxTeamMembers:   2,
      maxRoles:         2,
      maxTaskManagers:  0, // Task management not available on Free
      maxTasks:         0,
    },
    permissions: {
      workplaceAccess:             true,
      taskManagerAccess:           false, // No task management on Free
      analyticsAccess:             false,
      customRolesAccess:           false,
      advancedPermissionsAccess:   false,
      auditLogsAccess:             false,
    },
  },

  essential: {
    planId: 'essential',
    planName: 'Essential',
    price: 25000, // paise = ₹250
    limits: {
      maxCategories:    3,
      maxTextChannels:  3,   // 3 secure chat rooms per spec
      maxVoiceChannels: 1,
      maxTeamMembers:   4,
      maxRoles:         5,
      maxTaskManagers:  0,   // No task management on Essential per spec
      maxTasks:         0,
    },
    permissions: {
      workplaceAccess:             true,
      taskManagerAccess:           false, // Task management NOT included in Essential
      analyticsAccess:             false,
      customRolesAccess:           false,
      advancedPermissionsAccess:   false,
      auditLogsAccess:             false,
    },
  },

  growth: {
    planId: 'growth',
    planName: 'Growth',
    price: 79900, // paise = ₹799
    limits: {
      maxCategories:    10,
      maxTextChannels:  15,  // 15 secure chat rooms per spec
      maxVoiceChannels: 5,
      maxTeamMembers:   15,
      maxRoles:         20,
      maxTaskManagers:  1,   // 1 Advance Task Manager per spec
      maxTasks:         500, // Individual tasks within task boards
    },
    permissions: {
      workplaceAccess:             true,
      taskManagerAccess:           true,
      analyticsAccess:             true,
      customRolesAccess:           true,
      advancedPermissionsAccess:   false,
      auditLogsAccess:             false,
    },
  },

  scale: {
    planId: 'scale',
    planName: 'Scale',
    price: 199900, // paise = ₹1999
    limits: {
      maxCategories:    9999,
      maxTextChannels:  9999,
      maxVoiceChannels: 9999,
      maxTeamMembers:   9999,
      maxRoles:         9999,
      maxTaskManagers:  9999, // Unlimited Task Managers per spec
      maxTasks:         9999999,
    },
    permissions: {
      workplaceAccess:             true,
      taskManagerAccess:           true,
      analyticsAccess:             true,
      customRolesAccess:           true,
      advancedPermissionsAccess:   true,
      auditLogsAccess:             true,
    },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// Resource type → limits field mapping
//
// Used by subscriptionService.checkLimit(workspaceId, resourceType).
// "taskManager" maps to a task channel row in the task-channels table —
// each task channel/board is what the user creates as a "Task Manager".
// ─────────────────────────────────────────────────────────────────────────────
const RESOURCE_LIMIT_MAP = {
  category:    'maxCategories',
  textChannel: 'maxTextChannels',
  voiceChannel:'maxVoiceChannels',
  teamMember:  'maxTeamMembers',
  role:        'maxRoles',
  taskManager: 'maxTaskManagers', // Task board / task channel entity
  task:        'maxTasks',        // Individual task item
};

// ─────────────────────────────────────────────────────────────────────────────
// Human-readable display names for resource types.
// Used in error messages so users see "Task Manager" not "taskManager".
// ─────────────────────────────────────────────────────────────────────────────
const RESOURCE_DISPLAY_NAMES = {
  category:    'Category',
  textChannel: 'Text Channel',
  voiceChannel:'Voice Channel',
  teamMember:  'Member',
  role:        'Role',
  taskManager: 'Task Manager',
  task:        'Task',
};

module.exports = { PLAN_DEFINITIONS, RESOURCE_LIMIT_MAP, RESOURCE_DISPLAY_NAMES };
