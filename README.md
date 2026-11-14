# Meeting Notes — NestJS + Vite/React MVP

An original, Vietnamese-first Meeting Notes app inspired by the supplied UI reference. The ZIP includes **source code**; it is not a deployed product.

## Features implemented
- JWT password login/logout (single configured demo account)
- Create/list/view/delete meetings, meeting detail and dashboard
- Browser microphone recording with pause/resume/stop
- Deepgram streaming transcription over backend Socket.IO, with interim/final segments and speaker IDs
- Persist final segments to PostgreSQL with Prisma
- Manually rename Speaker 1, Speaker 2, etc. in meeting details
- Upload and playback recorded WebM audio
- LLM-generated Vietnamese summary, decisions, and action items
- Mark action items complete
- Responsive styling based on provided screenshot + 4 UI mockups

## Start locally

Requirements: Node.js 22+, npm, Docker (PostgreSQL), working Deepgram & OpenCode Go API keys.

```bash
cp .env.example .env
# Set JWT_SECRET, DEMO_EMAIL, DEMO_PASSWORD, DEEPGRAM_API_KEY, OPENCODE_API_KEY
# Optional: OPENCODE_MODEL (default: glm-5.3-flash), OPENCODE_BASE_URL
# Database is exposed on localhost only:
docker compose up -d postgres
npm install
npm run db:generate --workspace server
npm run db:push --workspace server
npm run dev
```

Open http://localhost:5173 and log in with the email/password from `.env`.

If the environment is different, set `DATABASE_URL` accordingly. API runs at http://localhost:3001, Vite proxies `/api` and `/socket.io` to the backend.

## Deploy on VPS

```bash
cp .env.example .env
# Set POSTGRES_PASSWORD and DATABASE_URL in .env, strong JWT_SECRET,
# DEMO_EMAIL, DEMO_PASSWORD, DEEPGRAM_API_KEY, OPENCODE_API_KEY
# Optional: OPENCODE_MODEL (default: glm-5.3-flash), OPENCODE_BASE_URL
# WEB_ORIGIN=https://meeting.example.com
# Note DATABASE_URL in compose is automatically overridden to the postgres service.
docker compose up -d --build
```

The web container listens on localhost:8080 and the API on localhost:3001. Put Caddy/Nginx HTTPS reverse proxy in front of `127.0.0.1:8080`. **Microphone capture requires HTTPS or localhost**. Configure `WEB_ORIGIN` with the exact public origin, including scheme, or Socket.IO CORS may reject requests.

Example Caddyfile:
```
meeting.example.com {
  reverse_proxy 127.0.0.1:8080
}
```

## Architecture

Browser MediaRecorder (WebM/Opus chunks) → authenticated Socket.IO on NestJS → Deepgram WebSocket streaming STT (`language=vi`, `diarize=true`, `interim_results=true`) → final segments in PostgreSQL. Stop → upload complete WebM file to VPS → OpenCode Go Chat Completions JSON → notes saved in PostgreSQL.

### Main endpoints
- `POST /auth/login`, `GET /auth/me`
- `GET /meetings`, `POST /meetings`, `GET /meetings/:id`, `DELETE /meetings/:id`
- `POST /meetings/:id/audio`, `GET /meetings/:id/audio`
- `PATCH /meetings/:id/speakers`
- `POST /meetings/:id/notes`
- `PATCH /meetings/:id/actions/:actionId`
- Socket.IO events: `live:start`, `live:audio`, `live:stop`, `live:interim`, `live:final`, `live:ready`, `live:error`

## Known MVP limitations

1. **Not tested end to end in this environment:** dependency installation was unavailable/timed out. Run build/type checks and a full recording test locally before deploying.
2. Deepgram language/model compatibility and Vietnamese speaker diarization should be verified against the enabled model and real meeting audio. Browser-only capture of a room does not determine real names; assign names manually.
3. One `getUserMedia` mic is used; no meeting bot, system audio, or video capture.
4. Audio is buffered in browser memory and uploaded on Stop; **long recordings are at risk of losing audio if the tab crashes**. Add incremental durable upload (IndexedDB/S3 chunks) before production.
5. Audio file uploads are buffered in server RAM with a 250 MB limit. Switch to streaming object storage uploads for production.
6. This MVP does not have signup, Google OAuth, password reset, organization roles, consent flows, billing, or multi-instance Socket.IO coordination.
7. API keys are backend-only. No exposed secrets should be committed. Replace seeded account before production. Store audio securely and obtain participant consent.
8. AI notes generation happens in the HTTP request. For long transcripts and concurrency, move processing to a background queue with retries and idempotency.
9. The live UI deliberately does not claim reliable real-time LLM summary: notes are generated when recording ends.
10. Speaker IDs are diarization estimates and can change; name assignment is manual. The transcript may contain duplicate segments from provider endpointing; verify with integration tests.

## ElevenLabs Scribe transcription

The live transcription provider is ElevenLabs Scribe v3 Live. Completed recordings are submitted to Scribe v3 Batch with diarization enabled before the AI summary runs. The batch result replaces provisional live transcript segments and returns Speaker 1, Speaker 2, etc., which can be renamed on the meeting detail page. Speaker labels are not identities; users should verify them.

Set the following server-side environment variables in `.env`:

```env
ELEVENLABS_API_KEY=your-elevenlabs-api-key
ELEVENLABS_LIVE_MODEL=scribe_v3_live
ELEVENLABS_BATCH_MODEL=scribe_v3
```

The browser records WebM/Opus for storage and separately sends downsampled 16-kHz mono PCM16 over the authenticated Socket.IO connection to NestJS. The NestJS gateway forwards base64 PCM audio to ElevenLabs WebSocket; the API key never reaches the browser. The client receives partial and committed transcripts. When recording stops, the audio file is uploaded and the batch endpoint (`POST /api/meetings/:id/transcribe`) runs before `POST /api/meetings/:id/notes`.

**Limitations:** Batch transcription is currently a synchronous HTTP request, so long recordings may require a worker queue and reverse-proxy timeout changes. Long recordings are buffered in the browser and should eventually be uploaded in resilient chunks. Realtime speaker IDs are not persisted; final diarization comes from batch. The browser microphone requires HTTPS outside localhost. Both live and batch requests incur ElevenLabs usage costs. If batch fails, provisional realtime segments are retained and the client may still generate notes from those; check server logs and transcript quality before relying on the summary.
