# BOS-OMEGA — Governed Multi-LLM Orchestration Platform

## Overview

BOS-OMEGA is a production-grade, full-stack platform for governed multi-LLM orchestration. It enables multi-provider routing, parallel execution, circuit breakers, tri-state evaluation, validation/repair, audit logging, and an administrative dashboard. The platform's core purpose is to provide a robust and secure environment for leveraging multiple large language models effectively for various domain-specific tasks.

## User Preferences

- My preferred communication style is direct and clear.
- I like functional programming paradigms where applicable.
- I prefer iterative development with frequent, small updates.
- Please ask for confirmation before implementing major architectural changes or significant feature additions.
- I prefer detailed explanations for complex features or decisions.
- Do not make changes to the `artifacts/api-server/src/bos/` folder without explicit instruction.
- Do not make changes to the `lib/api-zod/src/index.ts` file directly; it is codegen-managed.

## System Architecture

The project is structured as a pnpm monorepo, utilizing a Node.js/Express 5 backend, a React/Vite frontend, and a PostgreSQL database.

### Backend

The backend uses Express 5 with Drizzle ORM. The core component, the **BOS Engine**, manages the LLM orchestration pipeline, including input gating, task classification, tri-state evaluation (GO/HOLD/ABORT), model routing, execution (single, parallel, consensus modes), validation and repair, audit logging, and memory management. It includes adapters for various LLMs (OpenAI, Anthropic, Gemini, Ollama, Generic). The system supports multimodal pipelines for attachments, including text extraction (PDF, DOCX), image metadata, and video frame/audio transcription via `ffmpeg`.

### Frontend

The frontend is built with React 19, Vite 7, TailwindCSS v4, React Query, and Wouter. It features an administrative dashboard with pages for:
- **Task Console**: A ChatGPT-style conversation interface with persistent messages, structured details, and accessibility features.
- **Management Panels**: Provider Status, Model Registry, Task Logs, Fallback Events, Memory Manager (server-side and local browser storage), Audit Log, and Settings.

### Domain Personas

Three one-tap quick-launch personas (Legal Counsel, Engineer/Coder, Cyber Analyst) compose with the Master Prompt Kernel, providing structured outputs for specific domains.

### Local Memory Layer

Browser-stored memory (IndexedDB/localStorage) mirrors server memory items and is layered below server canon. Top-ranked items are prepended to task inputs, capped at a 500-token equivalent budget. A full CRUD UI for local memory is available.

### UI/UX Design

The UI offers two themes:
- **`theme-retro95`**: A default Windows 95-inspired theme.
- **`theme-modern`**: A "Claude-grade enterprise" theme with a warm, modern aesthetic.
The active theme is persisted in localStorage.

### Technical Implementations

- **API Codegen**: Orval generates Zod schemas and React Query hooks from an OpenAPI 3.1 specification.
- **Validation**: Zod v4 and drizzle-zod ensure robust input/output validation.
- **Security Posture**: Defense-in-depth measures include single-admin authentication, HMAC-SHA256-signed cookies, `helmet` for HTTP hardening, strict CSP, rate limiting, body limits, SSRF protection, input validation, sanitized errors, and AES-256-GCM encryption for API keys at rest.
- **Governance Controls**: Hardening features include extended `BosOutput` with denial explanations, stricter tri-state evaluation, improved repair engine, deterministic model routing, per-layer token budgets for memory, robust audit engine with durable queuing, budget governors, and compliance-mode pipeline gating. Attachment content is prefixed with `[UNTRUSTED ATTACHMENT CONTENT]` and checked for injection patterns.

## External Dependencies

- **PostgreSQL**: Primary database.
- **OpenAI API**: LLM models and Whisper transcription.
- **Anthropic API**: LLM models.
- **Google Gemini API**: LLM models.
- **Ollama**: Local and self-hosted LLM models.
- **`pdf-parse`**: PDF text extraction.
- **`mammoth`**: DOCX text extraction.
- **`sharp`**: Image metadata extraction and thumbnail generation.
- **`ffmpeg` / `fluent-ffmpeg`**: Video processing (frame extraction, audio stripping).
- **Replit AI Integrations Proxy**: Provides no-key access to OpenAI, Anthropic, and Gemini models within Replit.
- **`express-rate-limit`**: API rate limiting.
- **`helmet`**: HTTP header security.