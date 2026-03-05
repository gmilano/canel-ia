/**
 * Canel.IA — Batch PDF Ingestion
 * Procesa múltiples PDFs de normativa con categorías definidas
 */
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join, dirname, basename } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const { default: pdfParse } = await import('pdf-parse/lib/pdf-parse.js');

// ── Configuración de PDFs a procesar ─────────────────────────────────────
const PDF_CONFIG = [
  {
    file: '/tmp/canelones-pdfs/ordenanza_de_edificacion.pdf',
    output: 'ordenanza-edificacion-2025.json',
    categoria: 'Obras',
    subcategoria: 'Ordenanza de la Edificación',
    label: 'Ordenanza de la Edificación (2025)',
  },
  {
    file: '/tmp/canelones-pdfs/permiso_automatico.pdf',
    output: 'permiso-automatico.json',
    categoria: 'Obras',
    subcategoria: 'Permiso de Construcción Automático',
    label: 'Permiso de Construcción Automático (D10/2020)',
  },
  {
    file: '/tmp/canelones-pdfs/reglam_permiso_auto.pdf',
    output: 'reglam-permiso-auto.json',
    categoria: 'Obras',
    subcategoria: 'Reglamentación Permiso Automático',
    label: 'Reglamentación del Permiso de Construcción Automático',
  },
  {
    file: '/tmp/canelones-pdfs/reglam_ordenanza.pdf',
    output: 'reglam-ordenanza.json',
    categoria: 'Obras',
    subcategoria: 'Reglamentación de la Ordenanza',
    label: 'Reglamentación de la Ordenanza de Edificación (2015)',
  },
  {
    file: '/tmp/canelones-pdfs/decreto_0010_2021.pdf',
    output: 'decreto-0010-2021.json',
    categoria: 'Obras',
    subcategoria: 'Decreto 0010/2021',
    label: 'Decreto 0010/2021 — Ordenanza de la Edificación actualizada',
  },
  {
    file: '/tmp/canelones-pdfs/disposiciones_admin.pdf',
    output: 'disposiciones-admin.json',
    categoria: 'Obras',
    subcategoria: 'Disposiciones Administrativas',
    label: 'Disposiciones Administrativas de Regulación — Art. III',
  },
  {
    file: '/tmp/canelones-pdfs/ordenanza_limpieza.pdf',
    output: 'ordenanza-limpieza.json',
    categoria: 'Gestión Ambiental',
    subcategoria: 'Ordenanza de Limpieza Pública',
    label: 'Ordenanza de Limpieza Pública',
  },
  {
    file: '/tmp/canelones-pdfs/ordenanza_forestal.pdf',
    output: 'ordenanza-forestal.json',
    categoria: 'Gestión Ambiental',
    subcategoria: 'Ordenanza Forestal',
    label: 'Ordenanza Forestal de Canelones (Decreto 0012/2017)',
  },
  {
    file: '/tmp/canelones-pdfs/ordenanza_forestal_2018.pdf',
    output: 'ordenanza-forestal-2018.json',
    categoria: 'Gestión Ambiental',
    subcategoria: 'Ordenanza Forestal',
    label: 'Modificación Ordenanza Forestal (Decreto 0005/2018)',
  },
  {
    file: '/tmp/canelones-pdfs/ordenanza_costera.pdf',
    output: 'ordenanza-costera.json',
    categoria: 'Gestión Ambiental',
    subcategoria: 'Ordenanza Costera',
    label: 'Ordenanza Costera de Canelones (Decreto 011/2017)',
  },
];

function cleanText(t) {
  return t
    .replace(/\r/g, '')
    .replace(/[ \t]{3,}/g, '  ')
    .replace(/\n{4,}/g, '\n\n\n')
    .trim();
}

function parseArticles(rawText, config) {
  const text = cleanText(rawText);
  const articles = [];

  // Patrones de artículos (con y sin acento)
  const artPattern = /ART[IÍ]CULO\s+(\d+)[ºo°]?\.?\s*([^\n]{0,150})/gi;
  const matches = [...text.matchAll(artPattern)];

  const artPositions = matches.map(m => ({
    num: parseInt(m[1]),
    title: m[2].trim().replace(/\(.*?\)/g, '').trim(),
    index: m.index,
  }));

  const seen = {};

  for (let i = 0; i < artPositions.length; i++) {
    const art = artPositions[i];
    const nextIndex = i + 1 < artPositions.length ? artPositions[i + 1].index : text.length;
    const artText = text.slice(art.index, nextIndex);

    let titulo = art.title.trim().replace(/\s+/g, ' ');
    if (!titulo || titulo.length < 3 || /^[a-z,\.;(]/.test(titulo)) {
      // Tomar del contenido
      const firstLine = artText.split('\n').find(l => l.trim().length > 10)?.trim() || '';
      titulo = firstLine.slice(0, 80) || `Artículo ${art.num}`;
    }

    const contenido = artText
      .replace(/^ART[IÍ]CULO\s+\d+[ºo°]?\.?\s*/i, '')
      .replace(/\(Dec\.\s*[^)]+\)/gi, '')
      .replace(/\(Res\.\s*[^)]+\)/gi, '')
      .trim()
      .slice(0, 1500);

    if (contenido.length < 40) continue;

    const slug = config.subcategoria.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/-+/g, '-').slice(0, 25);
    const key = `${slug}-art${art.num}`;
    seen[key] = (seen[key] || 0) + 1;
    const id = key + (seen[key] > 1 ? `-${seen[key]}` : '');

    articles.push({
      id,
      numero: art.num.toString(),
      titulo,
      categoria: config.categoria,
      subcategoria: config.subcategoria,
      contenido,
      fuente: config.label,
    });
  }

  return articles;
}

/**
 * Para PDFs sin estructura de artículos numerados,
 * dividir por párrafos/secciones grandes
 */
function parseByChunks(rawText, config) {
  const text = cleanText(rawText);
  const chunks = [];

  // Dividir por secciones (encabezados en mayúsculas)
  const sections = text.split(/\n(?=[A-ZÁÉÍÓÚ]{5,}[\s\n])/);
  let chunkId = 1;

  for (const section of sections) {
    if (section.trim().length < 100) continue;
    const lines = section.trim().split('\n');
    const titulo = lines[0].trim().slice(0, 100);
    const contenido = section.trim().slice(0, 1500);

    chunks.push({
      id: `${config.subcategoria.toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 25)}-chunk${chunkId++}`,
      numero: null,
      titulo: titulo || `Sección ${chunkId}`,
      categoria: config.categoria,
      subcategoria: config.subcategoria,
      contenido,
      fuente: config.label,
    });
  }

  return chunks.slice(0, 100); // máx 100 chunks por PDF
}

// ── Procesar todos los PDFs ────────────────────────────────────────────────
let totalArticles = 0;
const outDir = join(ROOT, 'data', 'normativa');

for (const config of PDF_CONFIG) {
  if (!existsSync(config.file)) {
    console.log(`⚠️  No encontrado: ${config.file}`);
    continue;
  }

  process.stdout.write(`📄 ${basename(config.file)}... `);
  const data = readFileSync(config.file);
  const parsed = await pdfParse(data);
  const text = parsed.text;

  let articles = parseArticles(text, config);

  // Si extraemos muy pocos artículos, usar chunks
  if (articles.length < 5) {
    articles = parseByChunks(text, config);
    process.stdout.write(`(chunks) `);
  }

  const outPath = join(outDir, config.output);
  writeFileSync(outPath, JSON.stringify(articles, null, 2));
  totalArticles += articles.length;
  console.log(`✅ ${articles.length} items → ${config.output}`);
}

console.log(`\n📚 Total procesado: ${totalArticles} artículos/secciones`);
console.log('✅ Ingesta completada');
