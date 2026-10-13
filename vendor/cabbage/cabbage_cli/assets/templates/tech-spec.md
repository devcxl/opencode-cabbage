---
change: {{CHANGE_ID}}
cabbage_stage: {{STAGE_ID}}
change_type: {{CHANGE_TYPE}}
---

<!-- Replace every marked prompt before verifying this stage. Use N/A with a reason when a section does not apply. -->

# Context

## Current State

<!-- CABBAGE: Describe the current implementation, constraints, and the reason for change. -->

## Goals and Non-goals

- Goal: <!-- CABBAGE: State the technical outcome. -->
- Non-goal: <!-- CABBAGE: State what this design intentionally excludes. -->

# Requirements

| ID | Technical requirement | Source |
|---|---|---|
| TR-1 | <!-- CABBAGE: Record a functional or non-functional requirement. --> | <!-- CABBAGE: Link it to a requirement, constraint, or risk. --> |

# Design

## Overview

<!-- CABBAGE: Explain the proposed design and the responsibilities of each affected component. -->

<!-- CABBAGE: Add a Mermaid component, sequence, or state diagram when it improves reviewability; otherwise state N/A. -->

## Interfaces and Data

<!-- CABBAGE: Describe interface changes, data flow, state transitions, invariants, and compatibility constraints. -->

## Decision Boundaries

### AI Autonomous Decisions

- <!-- CABBAGE: List internal implementation decisions AI can independently make (e.g. private helpers, internal data structures, local refactoring). -->

### Human Gate Decisions

- <!-- CABBAGE: List critical decisions requiring explicit human review/approval (e.g. breaking API changes, storage migration, security policies). -->

# Alternatives

## Architecture Options Comparison

| Option | Architecture Approach | Benefits | Costs & Risks | Recommendation |
|---|---|---|---|---|
| Option A (Recommended) | <!-- CABBAGE: Describe primary approach. --> | <!-- CABBAGE: List advantages and trade-offs. --> | <!-- CABBAGE: List costs and risks. --> | Chosen |
| Option B (Alternative) | <!-- CABBAGE: Describe alternative approach (e.g. minimal vs decoupled). --> | <!-- CABBAGE: List advantages. --> | <!-- CABBAGE: List trade-offs/drawbacks. --> | Rejected |

## Selected Decision & Trade-off Rationale

<!-- CABBAGE: Explain why the chosen option won over alternatives and state accepted trade-offs. -->

# Security and Privacy

<!-- CABBAGE: Describe trust boundaries, authorization, sensitive data, validation, and privacy impact, or state N/A. -->

# Observability

| Signal | Purpose | Alert or dashboard |
|---|---|---|
| <!-- CABBAGE: Name a log, metric, trace, or audit event. --> | <!-- CABBAGE: Explain what it proves. --> | <!-- CABBAGE: Describe how operators use it. --> |

# Failure Modes

| Failure mode | Detection | Handling | Recovery |
|---|---|---|---|
| <!-- CABBAGE: Describe a credible failure. --> | <!-- CABBAGE: Describe the signal. --> | <!-- CABBAGE: Describe runtime behavior. --> | <!-- CABBAGE: Describe recovery steps. --> |

# Rollout

<!-- CABBAGE: Describe sequencing, feature flags, compatibility windows, migration, and success criteria. -->

# Rollback

<!-- CABBAGE: Define rollback triggers, steps, and data-safety constraints. -->

# Open Questions

- <!-- CABBAGE: Record unresolved technical decisions and an owner, or state N/A. -->
