/**
 * md → GitHub Project sync CLI (G4.S5.T2), board.js-style.
 *
 * Pushes the local md kanban (single source of truth) onto a GitHub Project v2
 * board: Spec → main Issue, Ticket → sub-issue, status → Status column,
 * blocked_by → issue dependencies, Goal → milestone + label. Idempotent — an
 * issue is resolved by title first and updated in place, never duplicated.
 *
 * The Progress Log is never pushed: sub-issue bodies carry the ticket
 * description / status / assignee / blocked_by + a link to the md only.
 *
 * Credential: GITHUB_TOKEN env, else the employee GitHub credential store
 * (default employee zouha108@caleo.com, override with GITHUB_EMPLOYEE).
 *
 * Usage:
 *   sync-github create <specRef> [--owner O --repo R --project P ...]
 *   sync-github sync <specRef>
 *   sync-github status <ticketRef> <column>
 *   sync-github pull <specRef>            # GitHub → md status sync (origin-recorded)
 *   sync-github feedback <specRef> [--plan-input FILE] [--mark-seen]
 *   sync-github list
 */
import { readFile } from "node:fs/promises";
import { scanBoard, defaultBoardRoot, type KanbanBoard } from "../src/kanban/scan.js";
import {
  buildIssueForSpec,
  buildIssueForTicket,
  createSpecIssue,
  findExistingTicketIssue,
  findSpecInBoard,
  statusFieldOptions,
  statusToColumn,
  syncBlockedBy,
  syncSpecStatus,
  syncTicketStatus,
  ticketState,
} from "../src/kanban/github-sync.js";
import {
  buildFeedbackProposal,
  buildPlanDraft,
  markCommentsSeen,
  pullProjectStatusChanges,
  readFeedbackContext,
  writeSyncState,
} from "../src/kanban/github-feedback.js";
import type { PlanInput } from "../src/kanban/planning.js";
import { GithubRestClient } from "../src/github/client.js";
import type { GithubCredential, GithubProject } from "../src/github/client.js";
import { readTicketFile, writeBoardFile } from "../src/kanban/board.js";
import { TICKET_STATUSES, type TicketStatus } from "../src/kanban/schema.js";
import { defaultSecretCipher } from "../src/employees/crypto.js";
import {
  MemoryEmployeeRegistry,
  PostgresEmployeeRegistry,
  type EmployeeRegistry,
} from "../src/employees/employees.js";

const args = process.argv.slice(2);

/** Read a `--flag value` pair, or undefined. */
function flag(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

const owner = flag("owner") ?? process.env.GITHUB_OWNER;
const repo = flag("repo") ?? process.env.GITHUB_REPO;
const employeeEmail = flag("employee") ?? process.env.GITHUB_EMPLOYEE ?? "zouha108@caleo.com";
const projectTitle = flag("project") ?? process.env.GITHUB_PROJECT;
const boardRoot = flag("board-root") ?? defaultBoardRoot();
const command = args[0];

function fail(message: string): never {
  console.error(`error: ${message}`);
  console.error("usage: sync-github <create|sync|status|pull|feedback|list> [args] [--owner O --repo R --project P --employee E --board-root PATH]");
  process.exit(1);
}

if (!command) {
  fail("command required");
}
if (!owner || !repo) {
  fail("--owner and --repo are required (or GITHUB_OWNER / GITHUB_REPO)");
}

/** Resolve the GitHub credential: GITHUB_TOKEN, else the employee store. */
async function resolveCredential(): Promise<GithubCredential> {
  const token = process.env.GITHUB_TOKEN;
  if (token) {
    return { type: "token", value: token };
  }
  const cipher = defaultSecretCipher();
  const connectionString = process.env.DATABASE_URL;
  const employees: EmployeeRegistry = connectionString
    ? new PostgresEmployeeRegistry({ connectionString, cipher })
    : new MemoryEmployeeRegistry([], { cipher });
  await employees.seed();
  const credential = await employees.getGithubCredential(employeeEmail);
  await employees.close();
  if (!credential) {
    fail(`no GitHub credential for "${employeeEmail}" in the employee store (set GITHUB_TOKEN or GITHUB_EMPLOYEE)`);
  }
  return credential;
}

/** The Project board for the repo: reuse by title, else create. */
async function resolveProject(
  github: GithubRestClient,
  credential: GithubCredential,
): Promise<GithubProject> {
  const title = projectTitle ?? `${owner}/${repo}`;
  const existing = await github.getProjectByTitle(credential, owner!, title);
  if (existing) {
    return existing;
  }
  return github.createProject(credential, owner!, title);
}

async function requireSpecIssue(github: GithubRestClient, credential: GithubCredential, specRef: string) {
  const payload = buildIssueForSpec(board, specRef);
  const issue = await github.getIssueByTitle(credential, owner!, repo!, payload.title);
  if (!issue) {
    fail(`no GitHub issue for ${specRef} — run "sync-github create ${specRef}" first`);
  }
  return { payload, issue };
}

const github = new GithubRestClient();
const credential = await resolveCredential();
const board: KanbanBoard = await scanBoard(boardRoot, { includeBody: true });

switch (command) {
  case "create": {
    const specRef = args[1];
    if (!specRef) {
      fail("create requires <specRef>");
    }
    const project = await resolveProject(github, credential);
    const result = await createSpecIssue(github, credential, owner!, repo!, board, specRef, project);
    console.log(
      `${result.created ? "created" : "updated"} ${result.specIssue.title} #${result.specIssue.number} on project "${project.title}"`,
    );
    for (const ticket of result.tickets) {
      console.log(`  ${ticket.ref} → #${ticket.number} (${ticket.created ? "created" : "updated"})`);
    }
    break;
  }

  case "sync": {
    const specRef = args[1];
    if (!specRef) {
      fail("sync requires <specRef>");
    }
    const project = await resolveProject(github, credential);
    const { spec, tickets } = findSpecInBoard(board, specRef);
    const { payload, issue } = await requireSpecIssue(github, credential, specRef);
    await github.updateIssue(credential, owner!, repo!, issue.number, {
      title: payload.title,
      body: payload.body,
      labels: payload.labels,
    });
    console.log(`synced ${specRef} #${issue.number}`);

    // Pre-resolve every blocked_by ref to an issue id so the dependency sync
    // stays synchronous.
    const refToId = new Map<string, number>();
    for (const ticket of tickets) {
      for (const blockedRef of ticket.ticket.blocked_by) {
        refToId.set(blockedRef, 0);
      }
    }
    for (const blockedRef of refToId.keys()) {
      const blockedIssue = await github.getIssueByTitle(credential, owner!, repo!, blockedRef);
      if (blockedIssue) {
        refToId.set(blockedRef, blockedIssue.id);
      }
    }

    const items = await github.getProjectItems(credential, project.id);
    await github.ensureStatusFieldOptions(credential, project.id, statusFieldOptions());
    // T9 (revert T6): the Spec card's Status column reflects the md Spec status
    // AND each ticket sub-issue is a card synced to its own Status column —
    // GitHub-native board behavior.
    await syncSpecStatus(github, credential, owner!, repo!, project, issue.number, spec.status, items);
    for (const ticket of tickets) {
      const ticketPayload = buildIssueForTicket(board, specRef, ticket.ref);
      const ticketIssue = await findExistingTicketIssue(
        github,
        credential,
        owner!,
        repo!,
        ticket.ref,
        ticketPayload.title,
      );
      if (!ticketIssue) {
        console.log(`  ${ticket.ref}: no GitHub issue — run create first`);
        continue;
      }
      await github.updateIssue(credential, owner!, repo!, ticketIssue.number, {
        title: ticketPayload.title,
        body: ticketPayload.body,
        state: ticketState(ticket.ticket.status),
      });
      await syncTicketStatus(github, credential, owner!, repo!, project, ticketIssue.number, ticket.ticket.status, items);
      await syncBlockedBy(
        github,
        credential,
        owner!,
        repo!,
        ticketIssue.number,
        ticket.ticket.blocked_by,
        (ref) => refToId.get(ref) ?? null,
      );
      console.log(`  ${ticket.ref} → #${ticketIssue.number} status=${ticket.ticket.status}`);
    }
    break;
  }

  case "status": {
    const ticketRef = args[1];
    const column = args[2];
    if (!ticketRef || !column) {
      fail("status requires <ticketRef> <column>");
    }
    if (!(TICKET_STATUSES as readonly string[]).includes(column)) {
      fail(`column must be one of: ${TICKET_STATUSES.join(", ")}`);
    }
    const { doc, ticket } = await readTicketFile(boardRoot, ticketRef);
    await writeBoardFile(boardRoot, { ref: ticketRef, frontmatter: { ...ticket, status: column as TicketStatus }, body: doc.body });
    console.log(`${ticketRef}: md status → ${column}`);

    const issue = await github.getIssueByTitle(credential, owner!, repo!, ticketRef);
    if (!issue) {
      console.log(`  no GitHub issue for ${ticketRef} — run create first`);
      break;
    }
    const project = await resolveProject(github, credential);
    await github.ensureStatusFieldOptions(credential, project.id, statusFieldOptions());
    await syncTicketStatus(github, credential, owner!, repo!, project, issue.number, column as TicketStatus);
    console.log(`  card #${issue.number} → Status "${statusToColumn(column as TicketStatus)}"`);
    break;
  }

  case "pull": {
    const specRef = args[1];
    if (!specRef) {
      fail("pull requires <specRef>");
    }
    const project = await resolveProject(github, credential);
    const result = await pullProjectStatusChanges(github, credential, owner!, repo!, board, project, {
      root: boardRoot,
      specRef,
    });
    console.log(`pull ${specRef}: ${result.applied.length} applied, ${result.conflicts.length} conflict(s), ${result.unchanged.length} unchanged`);
    for (const change of result.applied) {
      console.log(`  ${change.ref}: ${change.oldStatus} → ${change.newStatus}  (${change.origin})`);
    }
    for (const conflict of result.conflicts) {
      console.log(`  CONFLICT ${conflict.ref}: ${conflict.reason}`);
    }
    break;
  }

  case "feedback": {
    const specRef = args[1];
    if (!specRef) {
      fail("feedback requires <specRef>");
    }
    const planInputFile = flag("plan-input");
    const markSeen = args.includes("--mark-seen");

    const { context, state, newComments } = await readFeedbackContext(
      github,
      credential,
      owner!,
      repo!,
      boardRoot,
      board,
      specRef,
    );
    console.log(`feedback ${specRef} (#${context.issueNumber}): ${newComments.length} new comment(s)`);
    for (const comment of newComments) {
      console.log(`  [${comment.created_at}] @${comment.user_login ?? "?"}: ${comment.body.split("\n")[0]}`);
    }

    if (planInputFile && newComments.length > 0) {
      const raw = await readFile(planInputFile, "utf8");
      const plan: PlanInput = JSON.parse(raw);
      const { drafts } = await buildPlanDraft(boardRoot, plan);
      const proposal = buildFeedbackProposal(specRef, context, drafts);
      console.log(`proposal DRAFT for ${specRef}: ${drafts.length} md update(s) — NOT applied (human keeps final authority)`);
      for (const draft of drafts) {
        console.log(`  ${draft.kind} ${draft.doc.ref} → ${draft.doc.path}`);
      }
      const seen = markCommentsSeen(state, newComments, context.issueNumber);
      await writeSyncState(boardRoot, specRef, seen);
      console.log(`  marked ${newComments.length} comment(s) seen in sync-state.json`);
    } else if (markSeen && newComments.length > 0) {
      const seen = markCommentsSeen(state, newComments, context.issueNumber);
      await writeSyncState(boardRoot, specRef, seen);
      console.log(`  marked ${newComments.length} comment(s) seen in sync-state.json`);
    } else if (newComments.length > 0) {
      console.log(`  unprocessed — pass --plan-input FILE.json (PlanInput) to build a DRAFT proposal, or --mark-seen to acknowledge`);
    }
    break;
  }

  case "list": {
    const project = await resolveProject(github, credential);
    const items = await github.getProjectItems(credential, project.id);
    console.log(`project "${project.title}": ${items.length} card(s)`);
    for (const item of items) {
      console.log(`  #${item.issueNumber ?? "-"} ${item.title ?? "(draft)"} [${item.status ?? "no status"}]`);
    }
    break;
  }

  default:
    fail(`unknown command "${command}"`);
}
