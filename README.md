# 🏛️ Canel.IA — Normativa Departamental de Canelones

Asistente de inteligencia artificial para consultar la normativa departamental de Canelones, Uruguay. Powered by Claude (Anthropic).

## Stack
- Node.js ESM + Express
- Anthropic Claude (claude-haiku-4-5) con streaming SSE
- RAG con búsqueda keyword sobre corpus JSON
- Frontend dark mode con chat en tiempo real

## Variables de entorno
```
ANTHROPIC_API_KEY=sk-ant-api03-...
```

## Local
```bash
npm install
ANTHROPIC_API_KEY=sk-ant-... npm start
```
