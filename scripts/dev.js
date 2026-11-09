import { spawn, execSync } from 'child_process';
import { seedDatabase } from './seed-neo4j.js';
import dotenv from 'dotenv';

dotenv.config();

const port = String(process.env.PORT || 4321);

async function startDevEnvironment() {
  console.log('======================================================================');
  console.log(' SISTEMA NEURO-SIMBÓLICO DE ANÁLISIS LEGAL Y RAZONAMIENTO DEÓNTICO');
  console.log(' Google OKF + Neo4j Vectorial + OPA (Rego v1) + W3C SHACL + Gemini 3.6');
  console.log('======================================================================');

  // 1. Asegurar contenedor local Neo4j activo
  try {
    console.log('\n[1/4] Verificando contenedor local Neo4j...');
    execSync('docker compose up -d', { stdio: 'inherit' });
  } catch (err) {
    console.warn('[1/4] Advertencia al ejecutar docker compose up -d:', err.message);
  }

  // 2. Sembrar e indexar base de conocimiento OKF en Neo4j
  try {
    console.log('\n[2/4] Inicializando grafo Neo4j e indexando entradas atómicas OKF...');
    await seedDatabase();
  } catch (err) {
    console.warn('[2/4] Advertencia al sincronizar Neo4j inicial:', err.message);
  }

  // 3. Verificar Políticas Deónticas en OPA (Rego v1)
  try {
    console.log('\n[3/4] Verificando motor deóntico OPA (Rego v1)...');
    execSync('node scripts/opa-test.js', { stdio: 'inherit' });
  } catch (err) {
    console.error('[3/4] Error en validación de políticas OPA:', err.message);
    process.exit(1);
  }

  // 4. Iniciar servidor Fullstack Astro SSR
  console.log(`\n[4/4] Iniciando servidor Fullstack Astro SSR en http://localhost:${port} ...`);
  const astroProc = spawn('./node_modules/.bin/astro', ['dev', '--port', port], {
    stdio: 'inherit',
    env: {
      ...process.env,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ''} --dns-result-order=ipv4first`.trim(),
    },
  });

  astroProc.on('close', (code) => {
    process.exit(code ?? 0);
  });
}

startDevEnvironment();
