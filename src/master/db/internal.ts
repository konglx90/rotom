/**
 * MeshDb — composition root that wires each domain module's methods onto a
 * single instance. Public API surface (the method names) is unchanged from
 * the pre-split monolithic version, so the 27 call sites across
 * `src/master/*.ts` and `tests/*.ts` need no edits.
 *
 * Each domain module exports a method bag whose `this` is typed as
 * `MeshDbSelf` (see ./core.ts) — a structural shape with the `db` handle
 * plus the cross-module method signatures they reference (e.g.
 * messages.enqueueOffline → agents.getAgentById).
 *
 * The `declare` lines below are purely type annotations: they tell the
 * TypeScript compiler that the runtime instance (built via Object.assign in
 * the constructor) has every domain method, without forcing us to duplicate
 * signatures. Implementations live in the domain modules.
 */

import { MeshDbCore } from "./core.js";
import { agentMethods } from "./agents.js";
import { messageMethods } from "./messages.js";
import { domainMethods } from "./domains.js";
import { groupMethods } from "./groups.js";
import { issueMethods } from "./issues.js";
import { noteMethods } from "./notes.js";
import { collaborationMethods } from "./collaboration.js";
import { scheduleMethods } from "./schedules.js";
import { askBridgeMethods } from "./ask-bridges.js";
import { guidanceTemplateMethods } from "./guidance-templates.js";
import { schedulePatternMethods } from "./schedule-patterns.js";

export class MeshDb extends MeshDbCore {
  // ─── agents ────────────────────────────────────────────────────────────────
  declare getAgentByName: typeof agentMethods.getAgentByName;
  declare getAgentById: typeof agentMethods.getAgentById;
  declare getAgentByTokenHash: typeof agentMethods.getAgentByTokenHash;
  declare updateAgentName: typeof agentMethods.updateAgentName;
  declare listAgents: typeof agentMethods.listAgents;
  declare insertAgent: typeof agentMethods.insertAgent;
  declare updateAgentMeta: typeof agentMethods.updateAgentMeta;
  declare updateAgentEnabled: typeof agentMethods.updateAgentEnabled;
  declare setAgentOnline: typeof agentMethods.setAgentOnline;
  declare setAgentOffline: typeof agentMethods.setAgentOffline;
  declare resetAllOnline: typeof agentMethods.resetAllOnline;
  declare updateAgentToken: typeof agentMethods.updateAgentToken;
  declare getTokenRefreshedAt: typeof agentMethods.getTokenRefreshedAt;
  declare updateHeartbeat: typeof agentMethods.updateHeartbeat;
  declare deleteAgent: typeof agentMethods.deleteAgent;

  // ─── messages (offline queue / audit / log / cleanup / stats / config) ─────
  declare enqueueOffline: typeof messageMethods.enqueueOffline;
  declare popOffline: typeof messageMethods.popOffline;
  declare audit: typeof messageMethods.audit;
  declare listAudit: typeof messageMethods.listAudit;
  declare getConfig: typeof messageMethods.getConfig;
  declare setConfig: typeof messageMethods.setConfig;
  declare logMessage: typeof messageMethods.logMessage;
  declare listMessages: typeof messageMethods.listMessages;
  declare countMessages: typeof messageMethods.countMessages;
  declare agentMessageStats: typeof messageMethods.agentMessageStats;
  declare cleanupOldLogs: typeof messageMethods.cleanupOldLogs;
  declare stats: typeof messageMethods.stats;

  // ─── domains ────────────────────────────────────────────────────────────────
  declare listDomains: typeof domainMethods.listDomains;
  declare getDomainByName: typeof domainMethods.getDomainByName;
  declare getDomainById: typeof domainMethods.getDomainById;
  declare insertDomain: typeof domainMethods.insertDomain;
  declare updateDomain: typeof domainMethods.updateDomain;
  declare deleteDomain: typeof domainMethods.deleteDomain;
  declare renameDomainInAgents: typeof domainMethods.renameDomainInAgents;
  declare countAgentsByDomain: typeof domainMethods.countAgentsByDomain;
  declare canCrossDomain: typeof domainMethods.canCrossDomain;
  declare addCrossDomainRule: typeof domainMethods.addCrossDomainRule;
  declare listCrossDomainRules: typeof domainMethods.listCrossDomainRules;
  declare countCrossDomainRulesByDomain: typeof domainMethods.countCrossDomainRulesByDomain;
  declare deleteCrossDomainRule: typeof domainMethods.deleteCrossDomainRule;

  // ─── groups ────────────────────────────────────────────────────────────────
  declare createGroup: typeof groupMethods.createGroup;
  declare updateGroupWorkingDir: typeof groupMethods.updateGroupWorkingDir;
  declare updateGroupName: typeof groupMethods.updateGroupName;
  declare updateGroupPinned: typeof groupMethods.updateGroupPinned;
  declare updateGroupArchived: typeof groupMethods.updateGroupArchived;
  declare isGroupArchived: typeof groupMethods.isGroupArchived;
  declare backfillGroupDefaultWorkingDir: typeof groupMethods.backfillGroupDefaultWorkingDir;
  declare listGroups: typeof groupMethods.listGroups;
  declare listGroupsWithMembers: typeof groupMethods.listGroupsWithMembers;
  declare getGroupById: typeof groupMethods.getGroupById;
  declare deleteGroup: typeof groupMethods.deleteGroup;
  declare createGroupTyped: typeof groupMethods.createGroupTyped;
  declare getGroupByIdFull: typeof groupMethods.getGroupByIdFull;
  declare listGroupsByType: typeof groupMethods.listGroupsByType;
  declare updateGroupMetadata: typeof groupMethods.updateGroupMetadata;
  declare updateGroupGuidancePrompt: typeof groupMethods.updateGroupGuidancePrompt;
  declare addGroupMembers: typeof groupMethods.addGroupMembers;
  declare removeGroupMembers: typeof groupMethods.removeGroupMembers;
  declare getGroupMembers: typeof groupMethods.getGroupMembers;
  declare getGroupMemberSetting: typeof groupMethods.getGroupMemberSetting;
  declare listGroupMemberSettings: typeof groupMethods.listGroupMemberSettings;
  declare upsertGroupMemberSetting: typeof groupMethods.upsertGroupMemberSetting;
  declare clearGroupMemberSetting: typeof groupMethods.clearGroupMemberSetting;
  declare getGroupMemberProfile: typeof groupMethods.getGroupMemberProfile;
  declare upsertGroupMemberProfile: typeof groupMethods.upsertGroupMemberProfile;
  declare addGroupMessage: typeof groupMethods.addGroupMessage;
  declare addChatMessagePrompt: typeof groupMethods.addChatMessagePrompt;
  declare getChatMessagePrompt: typeof groupMethods.getChatMessagePrompt;
  declare getGroupMessages: typeof groupMethods.getGroupMessages;

  // ─── issues ────────────────────────────────────────────────────────────────
  declare createIssue: typeof issueMethods.createIssue;
  declare getIssueById: typeof issueMethods.getIssueById;
  declare listIssuesByGroup: typeof issueMethods.listIssuesByGroup;
  declare listAllIssues: typeof issueMethods.listAllIssues;
  declare updateIssueStatus: typeof issueMethods.updateIssueStatus;
  declare updateIssueWorkingDir: typeof issueMethods.updateIssueWorkingDir;
  declare updateIssueTodos: typeof issueMethods.updateIssueTodos;
  declare getLatestIssueBySessionId: typeof issueMethods.getLatestIssueBySessionId;
  declare getLatestIssueByCliTool: typeof issueMethods.getLatestIssueByCliTool;
  declare claimNextIssue: typeof issueMethods.claimNextIssue;
  declare addIssueEvent: typeof issueMethods.addIssueEvent;
  declare addIssueComment: typeof issueMethods.addIssueComment;
  declare getIssueMessages: typeof issueMethods.getIssueMessages;
  declare getIssueEvents: typeof issueMethods.getIssueEvents;
  declare getIssueEventById: typeof issueMethods.getIssueEventById;
  declare getIssueEventsByGroup: typeof issueMethods.getIssueEventsByGroup;
  declare findApprovalEvent: typeof issueMethods.findApprovalEvent;
  declare updateApprovalStatus: typeof issueMethods.updateApprovalStatus;
  declare deleteIssue: typeof issueMethods.deleteIssue;
  declare updateIssuePriority: typeof issueMethods.updateIssuePriority;
  declare updateIssueContent: typeof issueMethods.updateIssueContent;

  // ─── notes ─────────────────────────────────────────────────────────────────
  declare createNote: typeof noteMethods.createNote;
  declare getNoteById: typeof noteMethods.getNoteById;
  declare listNotesByGroup: typeof noteMethods.listNotesByGroup;
  declare updateNote: typeof noteMethods.updateNote;
  declare deleteNote: typeof noteMethods.deleteNote;

  // ─── collaboration ─────────────────────────────────────────────────────────
  declare createCollaborationIssue: typeof collaborationMethods.createCollaborationIssue;
  declare getActiveCollaborationsByGroup: typeof collaborationMethods.getActiveCollaborationsByGroup;
  declare recordCollaborationTurn: typeof collaborationMethods.recordCollaborationTurn;
  declare buildCollaborationContext: typeof collaborationMethods.buildCollaborationContext;
  declare hasAgentContributedThisRound: typeof collaborationMethods.hasAgentContributedThisRound;
  declare getRoundTracker: typeof collaborationMethods.getRoundTracker;
  declare isRoundComplete: typeof collaborationMethods.isRoundComplete;
  declare advanceCollaborationRound: typeof collaborationMethods.advanceCollaborationRound;
  declare completeCollaboration: typeof collaborationMethods.completeCollaboration;

  // ─── schedules ─────────────────────────────────────────────────────────────
  declare listScheduledTasks: typeof scheduleMethods.listScheduledTasks;
  declare getScheduledTask: typeof scheduleMethods.getScheduledTask;
  declare getDueScheduledTasks: typeof scheduleMethods.getDueScheduledTasks;
  declare createScheduledTask: typeof scheduleMethods.createScheduledTask;
  declare updateScheduledTask: typeof scheduleMethods.updateScheduledTask;
  declare deleteScheduledTask: typeof scheduleMethods.deleteScheduledTask;
  declare rescheduleTask: typeof scheduleMethods.rescheduleTask;
  declare triggerScheduledTask: typeof scheduleMethods.triggerScheduledTask;
  declare markScheduledTaskRun: typeof scheduleMethods.markScheduledTaskRun;
  declare disableScheduledTask: typeof scheduleMethods.disableScheduledTask;

  // ask_bridges —— Agent A 提问 B 的等回复 + 超时兜底 bridge
  declare createAskBridge: typeof askBridgeMethods.createAskBridge;
  declare getAskBridge: typeof askBridgeMethods.getAskBridge;
  declare listAskBridges: typeof askBridgeMethods.listAskBridges;
  declare getPendingAskBridges: typeof askBridgeMethods.getPendingAskBridges;
  declare findAtReplyForBridge: typeof askBridgeMethods.findAtReplyForBridge;
  declare findLatestReplyForBridge: typeof askBridgeMethods.findLatestReplyForBridge;
  declare markBridgeAnswered: typeof askBridgeMethods.markBridgeAnswered;
  declare markBridgeTimedOut: typeof askBridgeMethods.markBridgeTimedOut;
  declare cancelBridge: typeof askBridgeMethods.cancelBridge;
  declare getGroupMessageContent: typeof askBridgeMethods.getGroupMessageContent;
  declare findBridgesAnsweredByMessage: typeof askBridgeMethods.findBridgesAnsweredByMessage;
  declare findScheduledTaskByName: typeof askBridgeMethods.findScheduledTaskByName;
  declare findAskBridgeScheduledTask: typeof askBridgeMethods.findAskBridgeScheduledTask;
  declare findPendingBridge: typeof askBridgeMethods.findPendingBridge;

  // guidance_templates —— 群指导 prompt 模板库
  declare listGuidanceTemplates: typeof guidanceTemplateMethods.listGuidanceTemplates;
  declare getGuidanceTemplate: typeof guidanceTemplateMethods.getGuidanceTemplate;
  declare createGuidanceTemplate: typeof guidanceTemplateMethods.createGuidanceTemplate;
  declare updateGuidanceTemplate: typeof guidanceTemplateMethods.updateGuidanceTemplate;
  declare deleteGuidanceTemplate: typeof guidanceTemplateMethods.deleteGuidanceTemplate;

  // schedule_patterns —— 调度模式参考库
  declare listSchedulePatterns: typeof schedulePatternMethods.listSchedulePatterns;
  declare getSchedulePattern: typeof schedulePatternMethods.getSchedulePattern;
  declare createSchedulePattern: typeof schedulePatternMethods.createSchedulePattern;
  declare updateSchedulePattern: typeof schedulePatternMethods.updateSchedulePattern;
  declare deleteSchedulePattern: typeof schedulePatternMethods.deleteSchedulePattern;

  constructor(dbPath: string) {
    super(dbPath);
    // Each method bag's `this` resolves to this instance at call time. The
    // `declare` lines above ensure TypeScript sees these as members.
    Object.assign(this, agentMethods);
    Object.assign(this, messageMethods);
    Object.assign(this, domainMethods);
    Object.assign(this, groupMethods);
    Object.assign(this, issueMethods);
    Object.assign(this, noteMethods);
    Object.assign(this, collaborationMethods);
    Object.assign(this, scheduleMethods);
    Object.assign(this, askBridgeMethods);
    Object.assign(this, guidanceTemplateMethods);
    Object.assign(this, schedulePatternMethods);
  }
}