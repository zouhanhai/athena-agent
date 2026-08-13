export { parseFrontmatter, parseBoardMd, renderFrontmatter, renderBoardMd } from "./frontmatter.js";
export type { FrontmatterMap, FrontmatterValue } from "./frontmatter.js";
export {
  LAYERS,
  TICKET_STATUSES,
  SPEC_STATUSES,
  normalizeSpecStatus,
  parseGoal,
  parseSpec,
  parseTicket,
  parseBoardFrontmatter,
  BoardSchemaError,
} from "./schema.js";
export type {
  BoardLayer,
  TicketStatus,
  SpecStatus,
  BoardFrontmatter,
  BoardFrontmatterBase,
  GoalFrontmatter,
  SpecFrontmatter,
  TicketFrontmatter,
} from "./schema.js";
export {
  parseRef,
  refToPath,
  parseBoardFile,
  readBoardFile,
  writeBoardFile,
  writeTicketFile,
} from "./board.js";
export type { BoardRef, BoardFile, ParsedBoardFile, TicketDocument } from "./board.js";
export {
  scanBoard,
  scanRemoteBoard,
  defaultBoardRoot,
  FileBoardScanner,
} from "./scan.js";
export type {
  KanbanBoard,
  BoardGoal,
  BoardSpec,
  BoardTicket,
  BoardError,
  BoardScanner,
  RemoteBoardSource,
  ScanOptions,
} from "./scan.js";
export { parseProgressLog } from "./progress.js";
export type { ProgressLogEntry } from "./progress.js";
export {
  INDEX_VERSION,
  INDEX_FILENAME,
  toIndex,
  indexFilePath,
  readIndexFile,
  buildIndexFile,
  FileKanbanIndex,
} from "./index-file.js";
export type {
  KanbanIndex,
  KanbanIndexGoal,
  KanbanIndexSpec,
  KanbanIndexTicket,
  KanbanIndexService,
} from "./index-file.js";
export {
  PlanningError,
  goalId,
  specId,
  ticketId,
  buildGoal,
  buildSpec,
  buildTicket,
  validateGoalDraft,
  validateSpecDraft,
  validateTicketDraft,
  validatePlan,
  writeGoal,
  writeSpec,
  writeTicket,
  writeTickets,
  nextGoalRef,
  nextSpecRef,
  nextTicketRef,
  planGoal,
} from "./planning.js";
export type {
  GoalDraft,
  SpecDraft,
  TicketDraft,
  Plan,
  PlanTicket,
  PlanSpec,
  PlanInput,
  PlanInputSpec,
  PlannedGoal,
} from "./planning.js";
export {
  appendLog,
  claimTicket,
  reportTicket,
  claimableTickets,
  dispatchNotice,
  dispatchNext,
  ClaimError,
  ReportError,
} from "./protocol.js";
export type {
  ClaimInput,
  ClaimResult,
  ReportStatus,
  ReportInput,
  ReportResult,
  ClaimableTicket,
  DispatchNotice,
} from "./protocol.js";
export { GitClaimLock, ClaimConflictError } from "./git-lock.js";
export type { GitClaimLockOptions } from "./git-lock.js";
export {
  buildOriginMarker,
  appendGitHubSyncNote,
  pullProjectStatusChanges,
  SYNC_STATE_VERSION,
  syncStatePath,
  readSyncState,
  writeSyncState,
  emptySyncState,
  dedupeComments,
  markCommentsSeen,
  buildFeedbackContext,
  readFeedbackContext,
  buildPlanDraft,
  buildTicketDraft,
  buildSpecDraft,
  buildEditDraft,
  buildFeedbackProposal,
  applyFeedbackDraft,
} from "./github-feedback.js";
export type {
  AppliedStatusChange,
  SyncConflict,
  PullStatusResult,
  PullStatusOptions,
  SyncStateComment,
  SyncState,
  CommentDedupResult,
  FeedbackContext,
  FeedbackReadResult,
  DraftDocument,
  MdUpdateDraft,
  PlanDraft,
  MdEditPatch,
  FeedbackProposal,
} from "./github-feedback.js";
export {
  ROLE_IDS,
  ROLE_STAGES,
  ROLES,
  roleSoul,
  PLANNING_OWNER,
} from "./roles.js";
export type { RoleId, RoleStage, RoleSoul } from "./roles.js";
export {
  STATE_MACHINE,
  SPEC_STATE_MACHINE,
  TRANSITION_ACTOR,
  SPEC_TRANSITION_ACTOR,
  canTransition,
  transitionsFrom,
  transitionsTo,
  transitionId,
  specTransitionId,
  actorFor,
} from "./state-machine.js";
export type {
  TransitionId,
  SpecTransitionId,
  StateMachineKind,
  KanbanStatus,
} from "./state-machine.js";
export {
  rejectTicket,
  approveTicket,
  reDecompose,
  LifecycleError,
} from "./lifecycle.js";
export type {
  RejectInput,
  ApproveInput,
  ReDecomposeInput,
  ReDecomposeResult,
} from "./lifecycle.js";
