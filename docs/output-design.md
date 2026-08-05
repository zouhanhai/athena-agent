# athena-agent — Output Page Design (NotebookLM-Style Content Synthesis)

> Status: **Planned; to be implemented after core functionality (conversation/Kanban/knowledge base) is working**
> Goal: Generate txt / blog / charts / pptx / html output files from knowledge base files + web sources.
> Similar to NotebookLM's "generate notebook / report / presentation" capability.

## 1. Functional Positioning

User on the frontend Output page:
1. Select knowledge base files (wiki pages / documents retrieved by llm_wiki)
2. Add web sources (URLs, optional)
3. Choose output format: txt / blog / charts / pptx / html
4. Generate → Pi retrieves + synthesizes → calls tools → file preview / download

## 2. Generation Tool Matrix

| Output Format | Generation Method                     | Tool                    | Status          |
|---------------|---------------------------------------|-------------------------|-----------------|
| txt           | Pi directly generates plain text      | Pi capability           | ✅ Available    |
| blog          | Pi generates markdown/HTML blog       | Pi capability           | ✅ Available    |
| charts        | AI data visualization                 | microsoft/data-formulator (16k) | ⚠️ Needs verification |
| pptx          | Native PPTX (shapes/animations/charts)| ppt-master (installed v4.3.0) | ⚠️ Needs verification in Pi |
| html          | High-fidelity HTML presentation       | huashu-design (22k)     | ⚠️ Needs verification |

## 3. Architecture: Pi as Output Dispatcher

```
Output Page:
  User selects: knowledge base files + web URLs + output format
    ↓
  Portal backend → Pi (AgentSession):
    ├─ Retrieve knowledge base (llm_wiki/LightRAG)
    ├─ Fetch web URLs
    ├─ Synthesize content
    └─ Call generation tools by format:
        ├─ txt/blog → Pi writes directly
        ├─ charts   → data-formulator
        ├─ pptx     → ppt-master
        └─ html     → huashu-design
    ↓
  Generated file → frontend preview / download
```

## 4. Candidate Tool Survey

| Repo                    | Stars  | Type              | Notes                                                      |
|-------------------------|--------|-------------------|------------------------------------------------------------|
| hugohe3/ppt-master      | 43k    | Claude Code skill | Native PPTX (shapes/animations/charts/templates/narration), best in class |
| alchaincyf/huashu-design| 22.2k  | HTML skill        | High-fidelity prototypes/slides/animations + MP4 export    |
| Anionex/banana-slides   | 15.4k  | Full app          | "Vibe PPT", one-sentence generation, editable pptx         |
| addsumtech/slides_maker | 324    | Codex/Claude skill| Paper/code → PPTX, native charts/equations                 |
| microsoft/data-formulator | 16k  | Python system     | AI interactive data visualization                          |

**Key facts**:
- **ppt-master v4.3.0** is already installed locally (includes full workflows; it IS hugohe3/ppt-master)
- huashu-design is HTML-native, matching the "html display file" requirement
- data-formulator is Microsoft's AI visualization system

## 5. Implementation Strategy (Layered)

### POC Phase (after core runs, do first)
- txt / blog: Pi directly generates (most mature capability)
- charts: Pi generates data + basic chart library (ECharts / matplotlib)
- html: Pi generates HTML templates (CALEO style)
- pptx: Pi + python-pptx basic generation

### Enhancement Phase (after verifying skill feasibility)
- charts → integrate data-formulator (if API-izable)
- pptx → integrate ppt-master
- html → integrate huashu-design

## 6. Key Items to Verify

- ppt-master / huashu-design are Claude Code/Codex skills — **whether they can run inside Pi** needs verification
- Whether data-formulator can act as a headless API callable by Pi
- Whether Pi's ReAct can reliably orchestrate multi-format generation

## 7. Milestones

- **Core functionality** (M1-M4): Conversation / Kanban / Knowledge Base
- **Output Page**: implement after core is working (M5)
  - First: txt / blog / charts (Pi capability)
  - Later: pptx / html enhancement (integrate skills)

## 8. Implementation Essentials

1. Output Page added as a new sidebar entry in the Vue frontend
2. Portal backend adds /output route, dispatches Pi + tools
3. Pi connects to knowledge base retrieval via pi-mcp-adapter
4. Generated files stored on 6900XT, frontend preview + download
5. Reusable skills: ppt-master (installed), huashu-design, data-formulator
