/**
 * Canel.IA — PDF Ingestion Pipeline
 * Extrae artículos de normativa del PDF y genera corpus JSON
 */
import { readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

async function parsePDF(pdfPath) {
  const { default: pdfParse } = await import('pdf-parse/lib/pdf-parse.js');
  const data = readFileSync(pdfPath);
  const result = await pdfParse(data);
  return result.text;
}

function cleanText(t) {
  return t
    .replace(/\r/g, '')
    .replace(/[ \t]{3,}/g, '  ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Detectar sección/decreto actual para asignar categoría
 */
function detectSection(text) {
  if (/ORDENANZA DE LA EDIFICACI/i.test(text)) return 'Ordenanza de la Edificación';
  if (/PERMISO.*AUTOMÁTICO|AUTOMÁTICO.*PERMISO/i.test(text)) return 'Permiso de Construcción Automático';
  if (/REGLAMENTACI.*ORDENANZA|ORDENANZA.*REGLAMENTACI/i.test(text)) return 'Reglamentación de la Ordenanza';
  if (/NUEVO PERMISO|PERMISO.*CONSTRUCCIÓN.*REGLAMENT/i.test(text)) return 'Nuevo Permiso de Construcción';
  return null;
}

/**
 * Parsear artículos del texto extraído del PDF
 */
function parseArticles(rawText) {
  const text = cleanText(rawText);
  const articles = [];
  let currentSection = 'Ordenanza de la Edificación';
  let currentChapter = '';
  let currentTitle = '';

  // Split por artículos
  // Patrones: ARTICULO 1º, Art. 1, ARTÍCULO 1, etc.
  const artPattern = /ARTÍCULO\s+(\d+)[ºo°]?\.?\s*([^\n]{0,120})/gi;
  const matches = [...text.matchAll(artPattern)];

  // Detectar secciones (bloques entre artículos que contienen encabezados de sección)
  const sections = [
    { marker: /ORDENANZA DE LA EDIFICACI[OÓ]N/i, name: 'Ordenanza de la Edificación' },
    { marker: /COMPENDIO.*NORMATIVO|CANELONES INNOVA/i, name: 'Canelones Innova' },
    { marker: /REGLAMENTACI[OÓ]N.*D10|D10.*REGLAMENTACI[OÓ]N/i, name: 'Reglamentación D10/2020' },
    { marker: /PERMISO.*CONSTRUCCI[OÓ]N.*AUT[OÓ]M|AUT[OÓ]M.*PERMISO/i, name: 'Permiso Automático' },
    { marker: /NUEVO PERMISO|REGLAMENTACI.*NUEVO/i, name: 'Nuevo Permiso de Construcción' },
  ];

  // Detectar capítulos
  const chapterPattern = /CAPÍTULO\s+(I{1,3}V?|VI{0,3}|IX|X{0,3})[:\s]([^\n]{0,100})/gi;
  const titlePattern = /TÍTULO\s+(PRIMERO|SEGUNDO|TERCERO|CUARTO|QUINTO|SEXTO|SÉPTIMO|OCTAVO|NOVENO|[IVXLC]+)[:\s]?([^\n]{0,100})/gi;

  // Construir índice de posiciones de artículos en el texto
  const artPositions = [];
  for (const m of matches) {
    artPositions.push({
      num: parseInt(m[1]),
      title: m[2].trim().replace(/\(.*?\)/g, '').trim(),
      index: m.index,
    });
  }

  // Extraer contenido de cada artículo
  for (let i = 0; i < artPositions.length; i++) {
    const art = artPositions[i];
    const nextIndex = i + 1 < artPositions.length ? artPositions[i + 1].index : text.length;
    
    // Texto del artículo (desde el inicio hasta el próximo artículo)
    let artText = text.slice(art.index, nextIndex);
    
    // Detectar si hubo cambio de sección antes de este artículo
    const prevIndex = i > 0 ? artPositions[i - 1].index : 0;
    const interText = text.slice(prevIndex, art.index);
    for (const sec of sections) {
      if (sec.marker.test(interText)) {
        currentSection = sec.name;
        break;
      }
    }

    // Detectar capítulo
    const chMatch = interText.match(/CAPÍTULO\s+\S+[:\s]+([^\n]{5,80})/i);
    if (chMatch) currentChapter = chMatch[1].trim();

    // Detectar título
    const titleMatch = interText.match(/TÍTULO\s+\S+[:\s]*([^\n]{3,60})/i);
    if (titleMatch) currentTitle = titleMatch[1].trim();

    // Limpiar contenido del artículo
    const cleanContent = artText
      .replace(/^ARTÍCULO\s+\d+[ºo°]?\.?\s*/i, '')  // quitar el encabezado del artículo
      .replace(/\(Dec\.\s*[\d\/]+[\s\w–-]*\)/gi, '')  // quitar refs de decretos
      .replace(/^\s*[\w\s]+\s*\n/m, '')  // primera línea (título ya lo tenemos)
      .trim();

    // Solo incluir artículos con contenido sustancial
    if (cleanContent.length < 30) continue;
    // Limitar a los primeros 1500 chars del contenido
    const finalContent = cleanContent.slice(0, 1500).trim();

    articles.push({
      id: `edificacion-art${art.num}`,
      numero: art.num.toString(),
      titulo: art.title || `Artículo ${art.num}`,
      categoria: 'Obras',
      subcategoria: currentSection,
      capitulo: currentChapter || null,
      titulo_seccion: currentTitle || null,
      contenido: finalContent,
      fuente: `Compendio Normativo Canelones Innova — ${currentSection}`,
    });
  }

  return articles;
}

/**
 * Generar chunks para secciones importantes (reglamentos, tablas, etc.)
 */
function parseRegulations(rawText) {
  const text = cleanText(rawText);
  const chunks = [];

  // Extraer tabla de áreas y zonas
  const zoneMatch = text.match(/ZONIFICACI[OÓ]N[\s\S]{50,3000}?(?=ARTÍCULO|\n\n[A-Z]{5})/i);
  if (zoneMatch) {
    chunks.push({
      id: 'edificacion-zonificacion',
      numero: null,
      titulo: 'Zonificación y Categorías de Suelo',
      categoria: 'Obras',
      subcategoria: 'Ordenanza de la Edificación',
      contenido: zoneMatch[0].slice(0, 1200).trim(),
      fuente: 'Compendio Normativo Canelones Innova',
    });
  }

  // Extraer definiciones
  const defMatch = text.match(/DEFINICIONES[\s\S]{50,2000}?(?=ARTÍCULO\s+\d)/i);
  if (defMatch) {
    chunks.push({
      id: 'edificacion-definiciones',
      numero: null,
      titulo: 'Definiciones y Glosario Técnico',
      categoria: 'Obras',
      subcategoria: 'Ordenanza de la Edificación',
      contenido: defMatch[0].slice(0, 1200).trim(),
      fuente: 'Compendio Normativo Canelones Innova',
    });
  }

  return chunks;
}

// ── Main ───────────────────────────────────────────────────────────────────
const pdfPath = process.argv[2] || '/Users/gmilano/.openclaw/media/inbound/file_23---2c8e5dae-362d-4c87-82a1-0fa1b34c8b6d.pdf';

console.log(`📄 Procesando PDF: ${pdfPath}`);
const rawText = await parsePDF(pdfPath);
console.log(`   Texto extraído: ${rawText.length} caracteres, aprox. ${rawText.split('\n').length} líneas`);

const articles = parseArticles(rawText);
const extras = parseRegulations(rawText);
const all = [...articles, ...extras];

console.log(`📚 Artículos extraídos: ${articles.length}`);
console.log(`📋 Secciones extra: ${extras.length}`);
console.log(`✅ Total corpus: ${all.length}`);

// Mostrar muestra
console.log('\n--- Muestra (primeros 5 artículos) ---');
articles.slice(0, 5).forEach(a => {
  console.log(`Art. ${a.numero}: ${a.titulo}`);
  console.log(`  Sección: ${a.subcategoria}`);
  console.log(`  Contenido: ${a.contenido.slice(0, 120)}...`);
});

// Guardar
const outPath = join(ROOT, 'data', 'normativa', 'ordenanza-edificacion.json');
writeFileSync(outPath, JSON.stringify(all, null, 2));
console.log(`\n💾 Guardado en: ${outPath}`);
