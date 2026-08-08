# CALEO Document Taxonomy

Authoritative classification system for athena-agent knowledge base (llm_wiki + LightRAG).
Every ingested document is classified along **two orthogonal dimensions**:

- **type** — what the document *is* (its nature/function)
- **topic** — what the document is *about* (business domain, hierarchical)

Both are written into the wiki frontmatter and into LightRAG document metadata so the
knowledge graph can be filtered by either dimension.

---

## 1. type — Document Nature

Each document gets exactly **one** type. Use the criteria + counterexamples to avoid ambiguity.

| type           | Definition (use this)                                             | Counterexample (do NOT use when…)                          |
|----------------|------------------------------------------------------------------|------------------------------------------------------------|
| `report`       | Formal summary of facts/data/outcomes (financial report, project status, annual report, analysis). Records results. | It is a meeting *process* → `minute`. It is a future plan → `proposal`. |
| `minute`       | Meeting minutes / notes: agenda, attendees, decisions, action items. | It summarizes data/outcomes → `report`. |
| `spec`         | Technical/functional specification: SAP config, interfaces, architecture, requirements. States how a *system* should be. | It guides a *person* how to operate → `manual`. |
| `manual`       | How-to / operating guide / runbook. Step-by-step guidance for a person. | It states system requirements → `spec`. |
| `proposal`     | Proposal / plan / offering (pre-sales, project proposal, implementation plan). What we *intend to do*. | It records what was *done* → `report`. |
| `contract`     | Contract / agreement (NDA, partnership, procurement). Legally binding, signed parties. | It is a policy to follow → `policy`. |
| `policy`       | Policy / regulation / SOP / code of conduct. Rules to be followed. | It is a binding agreement → `contract`. |
| `presentation` | Slide deck / talk / training material. Delivered to an audience. | It is a standalone written guide → `manual`. |
| `event`        | Event / itinerary / agenda with time & place (team event, Sommerseminar, conference). | It summarizes the event afterward → `report`. |
| `source`       | External reference material (official docs, papers, vendor material) NOT authored in-house. | Authored in-house → use the fitting internal type. |
| `person`       | Employee / individual profile. | A general bio about a company → `entity`. |
| `entity`       | Introduction/profile of a named thing: client, company, project, product, dataset. | It is an abstract idea → `concept`. |
| `concept`      | Abstract idea / technique / phenomenon (e.g. consolidation method, ABAP technique). | It is a concrete named thing → `entity`. |

## 2. topic — Business Domain (hierarchical)

Each document gets **one** hierarchical topic path (slash-separated). Pick the **most specific** path that fits. Reuse an existing topic when the document belongs to it.

### SAP (core business)
```
sap/ai                                  SAP AI (AI Foundation, Joule, CoPilot)
sap/consolidation                       Consolidation
  sap/consolidation/bcs                 BCS
  sap/consolidation/group-reporting     Group Reporting
  sap/consolidation/ndc-financial-consolidation   NDC Financial Consolidation
sap/planning                            Planning
  sap/planning/bpc                      BPC
sap/business-warehouse                  Business Warehouse
  sap/business-warehouse/bw             BW / BW/4
  sap/business-warehouse/datasphere     Datasphere
sap/cloud                               Cloud
  sap/cloud/bdc                         BDC
  sap/cloud/btp                         BTP
sap/reporting                           Reporting
  sap/reporting/legacy                  Legacy (BEx, WAD)
  sap/reporting/sac                     SAC
  sap/reporting/lumira                  Lumira
sap/development                         Development
  sap/development/abap                  ABAP
  sap/development/cds                   CDS
  sap/development/fiori                 Fiori / UI5
sap/esg                                 ESG Reporting
sap/migration                           SAP migration (all paths)
  sap/migration/s4hana                  S/4HANA migration (greenfield/brownfield/bluefield)
  sap/migration/bw                      BW 7.5 → BW/4
  sap/migration/consolidation           BCS → BCS4 / Group Reporting
  sap/migration/onprem-to-cloud         On-premise → cloud (RISE, lift & shift)
```

### Finance (client business knowledge, non-SAP-system)
```
finance/accounting                      Accounting
finance/reporting                       Financial reporting
finance/consolidation                   Consolidation
finance/tax                             Tax
finance/audit                           Audit
```

### IT (non-SAP)
```
it/ai                                   AI / ML knowledge
it/data-intelligence                    Data Intelligence (SDI)
it/infra                                Infrastructure
it/cloud                                Cloud
it/security                             Security
it/devops                               DevOps
```

### Client projects (consulting)
```
client/<client-name>/<project-name>
```

### Corporate (company files)
```
corporate/hr                            HR
corporate/marketing                     Marketing
corporate/legal                         Legal
corporate/governance                    Governance
corporate/admin                         Admin / admin support
corporate/general                       General (company-wide / soft skills)
corporate/project-management            Project management
```

### Internal (company-internal)
```
internal/events                         Events (Sommerseminar)
internal/reports                        Internal reports
internal/onboarding                     Onboarding
internal/training                       Training
```

---

## 3. Usage

- **llm_wiki classifier prompt** embeds this taxonomy (type criteria + topic tree + existing topics) so the agent classifies consistently and reuses existing topics (grouping related docs).
- **Frontmatter** written to wiki pages: `type: <type>`, `topic: <topic-path>`.
- **LightRAG ingest** receives content **with** frontmatter so documents carry topic metadata.
- **Frontend Knowledge graph** filters by type and/or topic (hierarchical drill-down).
