# BOS-OMEGA — Governed Multi-LLM Orchestration Platform

## Overview

BOS-OMEGA is a production-grade, full-stack platform for governed multi-LLM orchestration. It features a Node.js/Express 5 backend, a React/Vite frontend, and a PostgreSQL database. The platform enables multi-provider routing, parallel execution, circuit breakers, tri-state evaluation, a validation/repair engine, audit logging, and an administrative dashboard. Its core purpose is to provide a robust and secure environment for leveraging multiple large language models effectively.

## User Preferences

- My preferred communication style is direct and clear.
- I like functional programming paradigms where applicable.
- I prefer iterative development with frequent, small updates.
- Please ask for confirmation before implementing major architectural changes or significant feature additions.
- I prefer detailed explanations for complex features or decisions.
- Do not make changes to the `artifacts/api-server/src/bos/` folder without explicit instruction.
- Do not make changes to the `lib/api-zod/src/index.ts` file directly; it is codegen-managed.

## System Architecture

The project is structured as a pnpm monorepo.

### Backend
The backend utilizes Express 5 with Drizzle ORM for PostgreSQL. Key components include:
- **BOS Engine**: Manages the LLM orchestration pipeline, including input gating, task classification, tri-state evaluation (GO/HOLD/ABORT), model routing based on capabilities and circuit breaker states, execution engine (single, parallel, consensus modes), validation and repair engines, audit logging, and memory management.
- **Providers**: Adapters for various LLMs (OpenAI, Anthropic, Gemini, Ollama, Generic).
- **Database**: PostgreSQL with Drizzle ORM, comprising 9 tables for managing providers, models, tasks, audit logs, and memory.
- **Attachments / Multimodal Pipeline**: Supports ChatGPT-style file uploads with SHA256-deduplicated local-disk storage, real text extraction (PDF, DOCX, various text formats), image metadata extraction, and `ffmpeg` for video frame extraction and Whisper transcription. Vision capabilities are dynamically routed based on model `multimodal` tags.

### Frontend
The frontend is built with React 19, Vite 7, TailwindCSS v4, React Query, and Wouter. It features an administrative dashboard with pages for:
- Task Console — ChatGPT-style conversation: persistent user/assistant message bubbles, copy-to-clipboard on every assistant reply, fully selectable answer text, expandable structured details (TriState vector, parallel responses, assumptions/uncertainties/failure modes, execution trace, raw JSON), `aria-live` thread for screen readers, and a "New chat" reset.
- Provider Status
- Model Registry
- Task Logs
- Fallback Events
- Memory Manager
- Audit Log
- Settings

### UI/UX Design
The UI follows a "Claude-grade enterprise" theme with a warm cream background, deep slate primary elements, and a clay coral accent for agentic calls-to-action. Typography uses Source Serif 4 for headlines, Inter for body text, and JetBrains Mono for IDs/code. It supports a light mode by default with an optional warm-slate dark variant.

### Technical Implementations
- **API Codegen**: Orval generates Zod schemas and React Query hooks from an OpenAPI 3.1 specification.
- **Validation**: Zod v4 and drizzle-zod are used for robust input and output validation.
- **Security Posture**: Employs defense-in-depth, including single-admin authentication, HMAC-SHA256-signed cookies, `helmet` for HTTP hardening, strict CSP, rate limiting, body limits, SSRF protection via `safeFetch`, input validation, sanitized error messages in production, and AES-256-GCM encryption for API keys at rest.

## External Dependencies

- **PostgreSQL**: Primary database for all persistent data.
- **OpenAI API**: For various LLM models and Whisper transcription.
- **Anthropic API**: For Anthropic LLM models.
- **Google Gemini API**: For Google Gemini LLM models.
- **Ollama**: For local and self-hosted LLM models.
- **`pdf-parse`**: For PDF text extraction.
- **`mammoth`**: For DOCX text extraction.
- **`sharp`**: For image metadata extraction and thumbnail generation.
- **`ffmpeg`**: For video processing (frame extraction, audio stripping).
- **Replit AI Integrations Proxy**: Provides no-key access to OpenAI, Anthropic, and Gemini models within the Replit environment.
- **`express-rate-limit`**: For API rate limiting.
- **`helmet`**: For securing HTTP headers.
- **`fluent-ffmpeg`**: Node.js wrapper for ffmpeg.