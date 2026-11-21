export interface WorkflowStage {
  id: string
  artifact: string
  template: string
  when?: string
  depends_on?: string[]
  validator?: "checklist"
  required_headings: string[]
}

export interface WorkflowDef {
  stages: WorkflowStage[]
}

export const IMPACT_FIELDS = [
  "product",
  "design",
  "architecture",
  "rfc",
  "api",
  "database",
  "security",
  "testing",
  "deployment",
  "operations",
  "performance",
] as const

export const WORKFLOWS: Record<"change" | "incident", WorkflowDef> = {
  change: {
    stages: [
      { id: "design", artifact: "tech-spec.md", template: "tech-spec.md", when: "impact.design", required_headings: ["Context", "Design", "Failure Modes", "Rollout"] },
      { id: "rfc", artifact: "rfc.md", template: "rfc.md", when: "impact.rfc", required_headings: ["Problem", "Proposal", "Alternatives"] },
      { id: "adr", artifact: "adr.md", template: "adr.md", when: "impact.architecture", required_headings: ["Context", "Decision", "Consequences"] },
      { id: "api", artifact: "api-design.md", template: "api-design.md", when: "impact.api", required_headings: ["Contract", "Compatibility"] },
      { id: "database", artifact: "database-design.md", template: "database-design.md", when: "impact.database", required_headings: ["Schema", "Migration", "Rollback"] },
      { id: "security", artifact: "security-review.md", template: "security-review.md", when: "impact.security", required_headings: ["Threats", "Controls"] },
      { id: "release", artifact: "release-plan.md", template: "release-plan.md", when: "impact.deployment", required_headings: ["Deployment", "Rollback", "Verification"] },
      {
        id: "tasks",
        artifact: "tasks.md",
        template: "change-record.md",
        depends_on: ["design", "rfc", "adr", "api", "database", "security", "release"],
        validator: "checklist",
        required_headings: ["Goal", "Design", "Tasks", "Verification"],
      },
    ],
  },
  incident: {
    stages: [
      { id: "incident", artifact: "incident.md", template: "incident.md", required_headings: ["Impact", "Timeline", "Mitigation"] },
      { id: "postmortem", artifact: "postmortem.md", template: "postmortem.md", depends_on: ["incident"], required_headings: ["Root Cause", "Contributing Factors", "Corrective Actions"] },
      { id: "tasks", artifact: "tasks.md", template: "tasks.md", depends_on: ["postmortem"], validator: "checklist", required_headings: ["Tasks", "Verification"] },
    ],
  },
}

/** OpenSpec 统一文档映射：默认归入 docs/specs/ 与 docs/adr/（不再建 18 个编号空目录） */
export const DEFAULT_STAGE_DOCS_MAPPING: Record<string, string> = {
  design: "specs/{change_id}.md",
  rfc: "specs/{change_id}-rfc.md",
  adr: "adr/{change_id}.md",
  api: "specs/{change_id}-api.md",
  database: "specs/{change_id}-database.md",
  security: "specs/{change_id}-security.md",
  release: "specs/{change_id}-release.md",
  incident: "incidents/{change_id}.md",
  postmortem: "incidents/{change_id}-postmortem.md",
}

const TEMPLATES: Record<string, string> = {
  "change-record.md": `---
change: {{CHANGE_ID}}
cabbage_stage: {{STAGE_ID}}
---

# Change: {{CHANGE_ID}}

## Goal
<!-- CABBAGE: Replace with the problem or goal of this change. -->

## Design
<!-- CABBAGE: Describe the minimal design and Testing Decisions (Test Seam + Observable Result). -->

## Tasks
- [ ] <!-- CABBAGE: Replace with concrete implementation tasks. -->

## Verification
<!-- CABBAGE: Record real test commands and observed results before verify. -->
`,
  "tasks.md": `---
change: {{CHANGE_ID}}
cabbage_stage: {{STAGE_ID}}
---

# Tasks: {{CHANGE_ID}}

## Tasks
- [ ] <!-- CABBAGE: Replace with concrete corrective tasks. -->

## Verification
<!-- CABBAGE: Record real verification commands and results. -->
`,
  "tech-spec.md": `---
change: {{CHANGE_ID}}
cabbage_stage: {{STAGE_ID}}
---

# Tech Spec: {{CHANGE_ID}}

## Context
<!-- CABBAGE: Describe current state and constraints. -->

## Design
<!-- CABBAGE: Describe the proposed design and Testing Decisions. -->

## Failure Modes
<!-- CABBAGE: Describe failure handling and recovery. -->

## Rollout
<!-- CABBAGE: Describe incremental rollout and compatibility. -->
`,
  "rfc.md": `---
change: {{CHANGE_ID}}
cabbage_stage: {{STAGE_ID}}
---

# RFC: {{CHANGE_ID}}

## Problem
<!-- CABBAGE: Describe the problem. -->

## Proposal
<!-- CABBAGE: Describe the proposal. -->

## Alternatives
<!-- CABBAGE: Describe alternatives and trade-offs. -->
`,
  "adr.md": `---
change: {{CHANGE_ID}}
cabbage_stage: {{STAGE_ID}}
---

# ADR: {{CHANGE_ID}}

## Context
<!-- CABBAGE: Describe the architectural decision context. -->

## Decision
<!-- CABBAGE: Record the chosen decision. -->

## Consequences
<!-- CABBAGE: Record positive and negative consequences. -->
`,
  "api-design.md": `---
change: {{CHANGE_ID}}
cabbage_stage: {{STAGE_ID}}
---

# API Design: {{CHANGE_ID}}

## Contract
<!-- CABBAGE: Describe endpoints/events, inputs, outputs and errors. -->

## Compatibility
<!-- CABBAGE: Describe versioning and backward compatibility. -->
`,
  "database-design.md": `---
change: {{CHANGE_ID}}
cabbage_stage: {{STAGE_ID}}
---

# Database Design: {{CHANGE_ID}}

## Schema
<!-- CABBAGE: Describe schema changes. -->

## Migration
<!-- CABBAGE: Describe forward migration. -->

## Rollback
<!-- CABBAGE: Describe rollback and data-safety constraints. -->
`,
  "security-review.md": `---
change: {{CHANGE_ID}}
cabbage_stage: {{STAGE_ID}}
---

# Security Review: {{CHANGE_ID}}

## Threats
<!-- CABBAGE: Describe trust boundaries, abuse cases and sensitive assets. -->

## Controls
<!-- CABBAGE: Describe authorization, validation, secrets, audit and mitigations. -->
`,
  "release-plan.md": `---
change: {{CHANGE_ID}}
cabbage_stage: {{STAGE_ID}}
---

# Release Plan: {{CHANGE_ID}}

## Deployment
<!-- CABBAGE: Describe deployment steps and ordering. -->

## Rollback
<!-- CABBAGE: Describe rollback triggers and steps. -->

## Verification
<!-- CABBAGE: Describe post-deploy verification. -->
`,
  "incident.md": `---
change: {{CHANGE_ID}}
cabbage_stage: {{STAGE_ID}}
---

# Incident: {{CHANGE_ID}}

## Impact
<!-- CABBAGE: Describe user/business impact. -->

## Timeline
<!-- CABBAGE: Record key timestamps and actions. -->

## Mitigation
<!-- CABBAGE: Record containment and recovery. -->
`,
  "postmortem.md": `---
change: {{CHANGE_ID}}
cabbage_stage: {{STAGE_ID}}
---

# Postmortem: {{CHANGE_ID}}

## Root Cause
<!-- CABBAGE: Describe the root cause. -->

## Contributing Factors
<!-- CABBAGE: Describe systemic contributing factors. -->

## Corrective Actions
<!-- CABBAGE: List owned corrective actions. -->
`,
}

export function renderStageTemplate(stage: WorkflowStage, changeId: string): string {
  const raw = TEMPLATES[stage.template] ?? TEMPLATES["change-record.md"]
  return raw
    .replaceAll("{{CHANGE_ID}}", changeId)
    .replaceAll("{{STAGE_ID}}", stage.id)
}
