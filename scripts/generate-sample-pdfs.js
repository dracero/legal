import fs from 'fs/promises';
import path from 'path';

const SAMPLES_DIR = path.resolve('./public/samples');

function buildSimplePDF(lines) {
  const escapedLines = lines.map((l) =>
    l
      .replace(/\\/g, '\\\\')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)')
  );

  const streamContent = [
    'BT',
    '/F1 11 Tf',
    '50 750 Td',
    '16 TL',
    ...escapedLines.map((line, idx) => (idx === 0 ? `(${line}) Tj` : `T* (${line}) Tj`)),
    'ET',
  ].join('\n');

  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n',
    `4 0 obj\n<< /Length ${Buffer.byteLength(streamContent, 'utf-8')} >>\nstream\n${streamContent}\nendstream\nendobj\n`,
    '5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  for (const obj of objects) {
    offsets.push(Buffer.byteLength(pdf, 'utf-8'));
    pdf += obj;
  }

  const xrefOffset = Buffer.byteLength(pdf, 'utf-8');
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    pdf += `${String(off).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;

  return Buffer.from(pdf, 'utf-8');
}

async function main() {
  await fs.mkdir(SAMPLES_DIR, { recursive: true });

  const dec911 = buildSimplePDF([
    'DECRETO 911/96 - REGLAMENTO DE HIGIENE Y SEGURIDAD PARA LA INDUSTRIA DE LA CONSTRUCCION',
    'ARTICULO 13.- El Empleador, el Comitente y el Director de Obra son solidaria y concurrentemente responsables del cumplimiento de las normas de Higiene y Seguridad conforme a la Ley 19.587 y Art. 1274 CCyCN.',
    'ARTICULO 20.- El Legajo Tecnico de Higiene y Seguridad debera estar firmado por un Ingeniero con matricula activa en el Consejo o Colegio de la jurisdiccion segun Decreto-Ley 6070/58 o Ley 10.416 PBA y visado conforme al Codigo de Etica Decreto 1099/84.',
  ]);
  await fs.writeFile(path.join(SAMPLES_DIR, 'decreto_911_96_construccion.pdf'), dec911);

  const res1254 = buildSimplePDF([
    'RESOLUCION MINISTERIAL 1254/18 - ACTIVIDADES RESERVADAS AL TITULO DE INGENIERIA (ART. 43 LEY 24.521)',
    'ARTICULO 1.- Establecense las actividades profesionales reservadas exclusivamente a los titulos de Ingenieria Civil, Electricista, Mecanica, Industrial, Quimica, Informatica, Electronica y Naval cuando comprometan de modo directo la seguridad publica conforme al Art. 1273 CCyCN.',
    'ARTICULO 2.- El ejercicio de actividades reservadas sin poseer el titulo con alcance habilitante ni la matricula activa del Decreto-Ley 6070/58 o Ley 10.416 PBA configura infraccion grave al Codigo de Etica Decreto 1099/84.',
  ]);
  await fs.writeFile(path.join(SAMPLES_DIR, 'res_ministerial_1254_18_incumbencias.pdf'), res1254);

  const velezDerogado = buildSimplePDF([
    'CODIGO CIVIL DE VELEZ SARSFIELD (LEY 340 DEROGADA POR LEY 26.994)',
    'ARTICULO 1646.- Tratandose de edificios u obras en inmuebles destinados a larga duracion, el constructor es responsable por su ruina total o parcial (NORMA DEROGADA - ESTADO HISTORICA).',
  ]);
  await fs.writeFile(path.join(SAMPLES_DIR, 'codigo_velez_derogado_art_1646.pdf'), velezDerogado);

  console.log('[Samples] 3 archivos PDF reales generados en public/samples/');
}

main();

