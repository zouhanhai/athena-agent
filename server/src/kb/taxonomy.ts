/**
 * CALEO document taxonomy (docs/taxonomy.md is authoritative).
 *
 * Every ingested document is classified along two orthogonal dimensions:
 *   - type:  what the document IS (14 kinds, with criteria + counterexamples)
 *   - topic: what the document is ABOUT (hierarchical slash-path tree)
 *
 * These constants feed BOTH the llm_wiki classify agent prompt (llmwiki.ts) and
 * the deterministic local fallback (ingest.ts localClassify/localTopic) so the
 * two paths classify consistently.
 */

/** The 14 document types (exactly one per document). */
export const DOC_TYPES = [
  "report",
  "minute",
  "spec",
  "manual",
  "proposal",
  "contract",
  "policy",
  "presentation",
  "event",
  "source",
  "person",
  "entity",
  "concept",
  "code",
] as const;

export type DocType = (typeof DOC_TYPES)[number];

/** Plural directory each type maps to under wiki/ (when no topic is derived). */
export const DOC_TYPE_DIRS: Record<DocType, string> = {
  report: "reports",
  minute: "minutes",
  spec: "specs",
  manual: "manuals",
  proposal: "proposals",
  contract: "contracts",
  policy: "policies",
  presentation: "presentations",
  event: "events",
  source: "sources",
  person: "people",
  entity: "entities",
  concept: "concepts",
  code: "code",
};

/** Prompt section: type criteria + counterexamples (from docs/taxonomy.md §1). */
export const TYPE_CRITERIA_PROMPT = `Pick exactly ONE document type, using the criteria and counterexamples:
- report: formal summary of facts/data/outcomes (financial report, project status, annual report, analysis). Records results. NOT a meeting process (-> minute) or a future plan (-> proposal).
- minute: meeting minutes/notes (agenda, attendees, decisions, action items). NOT a data/outcome summary (-> report).
- spec: technical/functional specification (SAP config, interfaces, architecture, requirements) — how a SYSTEM should be. NOT how-to for a PERSON (-> manual).
- manual: how-to / operating guide / runbook — step-by-step guidance for a person. NOT system requirements (-> spec).
- proposal: proposal/plan/offering (pre-sales, project proposal, implementation plan) — what we INTEND to do. NOT a record of what was DONE (-> report).
- contract: contract/agreement (NDA, partnership, procurement) — legally binding, signed parties. NOT a policy to follow (-> policy).
- policy: policy/regulation/SOP/code of conduct — rules to be followed. NOT a binding agreement (-> contract).
- presentation: slide deck / talk / training material delivered to an audience. NOT a standalone written guide (-> manual).
- event: event / itinerary / agenda with time & place (team event, Sommerseminar, conference). NOT a post-event summary (-> report).
- source: external reference material (official docs, papers, vendor material) NOT authored in-house. Authored in-house -> use the fitting internal type (report/minute/...).
- person: employee / individual profile. NOT a general company bio (-> entity).
- entity: introduction/profile of a named thing (client, company, project, product, dataset). NOT an abstract idea (-> concept).
- concept: abstract idea / technique / phenomenon (e.g. consolidation method, ABAP technique). NOT a concrete named thing (-> entity).
- code: actual SAP source code / model definition (ABAP class/method, CDS view DDL, UI5 controller/view/fragment/Component). NOT a written description of code (-> spec/manual/concept); the source text itself is required, typically pulled from SAP via MCP or a repo.`;

/** Prompt section: hierarchical topic tree (from docs/taxonomy.md §2). */
export const TOPIC_TREE_PROMPT = `Pick ONE hierarchical topic path (slash-separated). Choose the MOST SPECIFIC path that fits; reuse an existing topic when the document belongs to it.
Allowed topic tree:
- sap/ai (SAP AI / Joule / CoPilot)
- sap/consolidation
- sap/consolidation/bcs
- sap/consolidation/group-reporting
- sap/consolidation/ndc-financial-consolidation
- sap/planning
- sap/planning/bpc
- sap/business-warehouse
- sap/business-warehouse/bw
- sap/business-warehouse/datasphere
- sap/cloud
- sap/cloud/bdc
- sap/cloud/btp
- sap/reporting
- sap/reporting/legacy (BEx, WAD)
- sap/reporting/sac
- sap/reporting/lumira
- sap/development
- sap/development/abap
- sap/development/cds
- sap/development/fiori
- sap/esg
- sap/migration
- sap/migration/s4hana
- sap/migration/bw
- sap/migration/consolidation
- sap/migration/onprem-to-cloud
- finance/accounting
- finance/reporting
- finance/consolidation
- finance/tax
- finance/audit
- it/ai
- it/data-intelligence
- it/infra
- it/cloud
- it/security
- it/devops
- client/<client-name>/<project-name> (use real names, e.g. client/acme/consolidation)
- corporate/hr
- corporate/marketing
- corporate/legal
- corporate/governance
- corporate/admin
- corporate/general
- corporate/project-management
- internal/events (e.g. Sommerseminar)
- internal/reports
- internal/onboarding
- internal/training
- code/<system-name> (SAP system the code was pulled from, e.g. code/prd, code/dev, code/qas; use code/unknown when the system is not reported). CODE ONLY: for actual source-code documents (type: code). Keep the sap/development/abap|cds|fiori branches for prose ABOUT development — the code/ branch is for the source text itself.`;

/** Compact list of the 14 type keys, used in the JSON reply contract. */
export const DOC_TYPES_JOINED = DOC_TYPES.join(", ");
