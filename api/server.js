import express from 'express';
import compression from 'compression';
import cors from 'cors';
import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, readdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const app = express();
const PORT = process.env.PORT || 3031;

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// ── Cargar corpus de normativa al inicio ──────────────────────────────────
let CORPUS = [];
function loadCorpus() {
  const dir = join(ROOT, 'data', 'normativa');
  if (!existsSync(dir)) return;
  const files = readdirSync(dir).filter(f => f.endsWith('.json'));
  CORPUS = files.flatMap(f => {
    try { return JSON.parse(readFileSync(join(dir, f), 'utf-8')); }
    catch { return []; }
  });
  console.log(`📚 Corpus cargado: ${CORPUS.length} artículos/secciones`);
}
loadCorpus();

// ── Búsqueda semántica simple (keyword + TF-IDF básico) ───────────────────
function searchCorpus(query, topK = 8) {
  if (CORPUS.length === 0) return [];
  const words = query.toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '') // remover acentos
    .split(/\W+/).filter(w => w.length > 3);

  const scored = CORPUS.map(art => {
    const text = (art.titulo + ' ' + art.contenido + ' ' + (art.categoria || ''))
      .toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    let score = 0;
    for (const w of words) {
      const count = (text.match(new RegExp(w, 'g')) || []).length;
      score += count * (text.indexOf(w) < 200 ? 2 : 1); // bonus si está al principio
    }
    return { ...art, score };
  });

  return scored
    .filter(a => a.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);
}

// ── Middleware ─────────────────────────────────────────────────────────────
app.use(compression());
app.use(cors());
app.use(express.json());
app.use(express.static(join(ROOT, 'public')));

// ── SSE: Chat con streaming ────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { message, history = [] } = req.body;
  if (!message?.trim()) return res.status(400).json({ error: 'Mensaje vacío' });

  // Buscar artículos relevantes
  const relevant = searchCorpus(message);
  const context = relevant.length > 0
    ? relevant.map(a =>
        `[${a.categoria || 'General'}] ${a.numero ? 'Art. ' + a.numero + ' — ' : ''}${a.titulo}\n${a.contenido}`
      ).join('\n\n---\n\n')
    : 'No se encontraron artículos específicos en el corpus para esta consulta.';

  const systemPrompt = `Sos Canel, el asistente de normativa departamental de la Intendencia de Canelones, Uruguay.
Tu función es ayudar a los ciudadanos a entender y consultar la normativa departamental vigente.

CONTEXTO DE NORMATIVA RELEVANTE:
${context}

INSTRUCCIONES:
- Respondé en español rioplatense (vos, podés, etc.)
- Si la respuesta está en el contexto de normativa, citá el artículo específico
- Si no encontrás la información en el corpus, decilo claramente y sugerí consultar directamente a la Intendencia
- Explicá la normativa en lenguaje ciudadano accesible, sin jerga legal innecesaria
- Cuando cites un artículo, indicá la categoría y número de manera clara
- Sé conciso pero completo
- Si la pregunta es ambigua, pedí aclaración`;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  // Historial de conversación (máx 6 turnos)
  const messages = [
    ...history.slice(-6).map(h => ({ role: h.role, content: h.content })),
    { role: 'user', content: message }
  ];

  try {
    const stream = anthropic.messages.stream({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1024,
      system: systemPrompt,
      messages,
    });

    for await (const chunk of stream) {
      if (chunk.type === 'content_block_delta' && chunk.delta.type === 'text_delta') {
        res.write(`data: ${JSON.stringify({ type: 'token', content: chunk.delta.text })}\n\n`);
      }
    }

    // Enviar artículos de referencia al final
    res.write(`data: ${JSON.stringify({ type: 'done', sources: relevant.slice(0,3).map(a => ({
      numero: a.numero,
      titulo: a.titulo,
      categoria: a.categoria,
    }))})}\n\n`);

  } catch (err) {
    console.error('[chat] Error:', err.message);
    res.write(`data: ${JSON.stringify({ type: 'error', message: err.message })}\n\n`);
  } finally {
    res.end();
  }
});

// ── Buscar artículos (para el explorador) ─────────────────────────────────
app.get('/api/buscar', (req, res) => {
  const { q, categoria } = req.query;
  let results = q ? searchCorpus(q, 20) : CORPUS.slice(0, 20);
  if (categoria) results = results.filter(a => a.categoria === categoria);
  res.json({
    total: results.length,
    articles: results.map(({ score: _, ...a }) => a),
  });
});

// ── Categorías disponibles ─────────────────────────────────────────────────
app.get('/api/categorias', (req, res) => {
  const cats = [...new Set(CORPUS.map(a => a.categoria).filter(Boolean))].sort();
  res.json(cats);
});

// ── Stats ──────────────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const cats = [...new Set(CORPUS.map(a => a.categoria).filter(Boolean))];
  res.json({ total: CORPUS.length, categorias: cats.length });
});

// ── Health ─────────────────────────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ status: 'ok', corpus: CORPUS.length }));

app.listen(PORT, () => {
  console.log(`🏛️  Canel.IA corriendo en http://localhost:${PORT}`);
  console.log(`   Corpus: ${CORPUS.length} artículos`);
  console.log(`   Modelo: claude-haiku-4-5-20251001`);
});
