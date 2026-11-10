# Sistema Neuro-Simbólico de Análisis Legal y Razonamiento Deóntico

Plataforma Fullstack construida sobre **Astro 5 SSR + Google GenAI (`gemini-3.6-flash`) + Embeddings Locales de Hugging Face (`Xenova/all-MiniLM-L6-v2`) + Neo4j Híbrido + Google OKF (Open Knowledge Format) + Open Policy Agent (OPA / Rego v1) + W3C SHACL**.

El sistema es **100% agnóstico de dominio y guiado estrictamente por documentos**: no posee normas preinstaladas ni reglas hardcodeadas; analiza exclusivamente el documento normativo cargado por el usuario, extrayendo dinámicamente su **ontología** (sujetos, conceptos jurídicos) y su **matriz deóntica** (`OBLIGACION`, `PROHIBICION`, `PERMISION`, `SANCION_NULIDAD`).

---

## 📋 Requisitos Previos

* **Node.js** `>= 22.0.0` (con `npm`)
* **Docker** y **Docker Compose** (para la base de datos gráfica Neo4j local)
* Una o más claves API de **Google Gemini** (`gemini-3.6-flash`)

---

## 🚀 Instalación y Puesta en Marcha (`npm run dev`)

```bash
# 1. Instalar dependencias de Node.js
npm install

# 2. Crear el archivo .env a partir de la plantilla
cp .env.example .env

# 3. Editar .env y colocar al menos una clave en GEMINI_API_KEY
# GEMINI_API_KEY=AIzaSy..., AIzaSy...

# 4. Levantar toda la arquitectura con un solo comando
npm run dev
```

### ¿Qué automatiza [`npm run dev`](scripts/dev.js)?

1. **Neo4j Local (`docker compose up -d`):** Levanta el contenedor `neo4j-data-legal` ([`docker-compose.yml`](docker-compose.yml), imagen `neo4j:5.20.0-community`) exponiendo **Bolt en `7688`** y el **Browser Web en `http://localhost:7475`**.
2. **Esquema e Índices en Neo4j ([`scripts/seed-neo4j.js`](scripts/seed-neo4j.js) + [`src/lib/neo4j/schema.js`](src/lib/neo4j/schema.js)):**
   * Reconcilia restricciones (`legal_okf_id_unique`, `concepto_nombre_unique`, `regla_deontica_id_unique`).
   * Elimina índices heredados o incompatibles si existieran y asegura el índice vectorial de **384 dimensiones** (`legal_normas_vector_index`, similitud coseno) y el índice léxico Full-Text BM25 (`legal_normas_fulltext_index`).
   * Sincroniza únicamente las normas `.md` locales existentes en [`src/content/okf/`](src/content/okf/) (ignorado en Git mediante [`.gitignore`](.gitignore); en un clon limpio inicia vacío con `.gitkeep`).
3. **Motor OPA Autocontenido ([`scripts/opa-test.js`](scripts/opa-test.js) + [`src/lib/opa/binary.js`](src/lib/opa/binary.js)):**
   * Verifica o instala automáticamente el binario de **Open Policy Agent `v1.22.0`** dentro del directorio de la aplicación en **`./bin/opa`**.
   * Ejecuta los tests unitarios de Rego v1 ([`src/lib/opa/policies/legal_deontico_test.rego`](src/lib/opa/policies/legal_deontico_test.rego)).
4. **Servidor Web Astro SSR:** Inicia la interfaz web y los endpoints de API en **`http://localhost:4321`**.

---

## 🔑 Variables de Entorno ([`.env.example`](.env.example)) y Seguridad ([`.gitignore`](.gitignore))

El archivo [`.gitignore`](.gitignore) excluye `.env`, `.env.*` (excepto [`.env.example`](.env.example)), `/bin/`, `src/content/okf/*.md`, `node_modules/`, `dist/`, `.astro/` y cachés locales.

### Variables de Entorno Soportadas ([`src/lib/config.ts`](src/lib/config.ts))

| Variable | Valor por defecto | Descripción |
| :--- | :--- | :--- |
| `PORT` | `4321` | Puerto del servidor Astro SSR. |
| `GEMINI_MODEL` | `gemini-3.6-flash` | Modelo único obligatorio (sin modelo fallback). |
| `GEMINI_MAX_OUTPUT_TOKENS` | `32768` | Límite de tokens de salida para dictamen y lotes. |
| `GEMINI_API_KEY` | — | Claves separadas por coma, `;` o salto de línea (también admite `GEMINI_API_KEYS`, `GOOGLE_API_KEY`, `GOOGLE_API_KEYS` y `GEMINI_API_KEY_<N>`). |
| `HUGGINGFACE_EMBEDDING_MODEL` | `Xenova/all-MiniLM-L6-v2` | Modelo local ONNX (`HF_EMBEDDING_MODEL` como alias). |
| `NEO4J_URI` | `bolt://localhost:7688` | URI Bolt de Neo4j. |
| `NEO4J_USER` | `neo4j` | Usuario de Neo4j. |
| `NEO4J_PASSWORD` | `password` | Contraseña de Neo4j. |
| `NEO4J_DATABASE` | `neo4j` | Base de datos Neo4j. |
| `NEO4J_VECTOR_INDEX` | `legal_normas_vector_index` | Nombre del índice vectorial coseno. |
| `NEO4J_FULLTEXT_INDEX` | `legal_normas_fulltext_index` | Nombre del índice léxico BM25. |
| `NEO4J_VECTOR_DIMENSIONS` | `384` | Dimensiones del vector de embeddings. |
| `OPA_BIN_PATH` | `./bin/opa` | Ruta al binario local de OPA. |
| `OPA_SERVER_URL` | `""` | URL REST opcional si se usa OPA externo en vez de CLI local. |
| `OPA_POLICY_DIR` | `./src/lib/opa/policies` | Directorio de políticas `.rego`. |
| `OPA_QUERY_PATH` | `data.legal.deontico` | Ruta del paquete Rego evaluado. |
| `SHACL_SHAPES_PATH` | `./src/lib/shacl/shapes.ttl` | Ruta al archivo Turtle con shapes SHACL. |
| `SHACL_ONTOLOGY_NS` | `http://antigravity.ai/ontologia/legal#` | Namespace ontológico RDF. |
| `OKF_CONTENT_DIR` | `./src/content/okf` | Directorio donde se persisten fichas `.md`. |
| `PROMPTS_DIR` | `./src/lib/prompts` | Directorio de *system prompts* editables (`.md`) con recarga automática. |

### Rotación Inteligente de API Keys de Gemini ([`src/lib/gemini/key-rotator.ts`](src/lib/gemini/key-rotator.ts))

* **Balanceo *Round-Robin*:** Alterna las peticiones entre todas las claves activas.
* ***Failover* Automático:** Si una clave agota su cuota diaria (`PerDay` / `FreeTier` / `retryDelay > 120s`), entra en *cooldown* calculado según `retryDelay` y conmuta instantáneamente a la siguiente clave disponible.
* **Resiliencia ante `503` y `RPM`:** Ante límites por minuto (`RPM`) espera el *cooldown* corto automáticamente (`<= 65s`); ante alta demanda transitoria (`503` / `UNAVAILABLE`) aplica *backoff* sin bloquear la última clave activa.
* **Recarga en Caliente (*Hot-Reload*):** Detecta claves agregadas, editadas o eliminadas en `.env` sin reiniciar el servidor.

### Embeddings Locales y Motor OPA Autocontenido

* **Embeddings ([`src/lib/embeddings/huggingface.ts`](src/lib/embeddings/huggingface.ts)):** Se ejecutan **100% localmente** mediante `@xenova/transformers` (`Xenova/all-MiniLM-L6-v2`, 384 dimensiones), sin tokens ni llamadas remotas pagas.
* **OPA ([`src/lib/opa/binary.js`](src/lib/opa/binary.js) + [`src/lib/opa/evaluator.ts`](src/lib/opa/evaluator.ts)):** Además de ejecutarse al inicio con `npm run dev` y `npm run opa:test`, `evaluarEnServidorOPA` y `getOpaRuntimeLabel` aseguran automáticamente `./bin/opa` en tiempo de ejecución (cubriendo también `npm run dev:astro` y `npm run preview`), mostrando la versión real detectada en la barra superior de [`src/pages/index.astro`](src/pages/index.astro).

---

## 📄 Flujo de Trabajo y Arquitectura

### 1. Ingesta Dinámica de Normas y Atomización OKF ([`src/lib/okf/pdf-ingestor.ts`](src/lib/okf/pdf-ingestor.ts))
* Acepta uno o varios archivos PDF binarios (`multipart/form-data` en campos `file` o `files`) y cargas JSON (`fileBase64` o texto UTF-8 directo `rawPdfText`) en [`POST /api/laws/upload`](src/pages/api/laws/upload.ts). Desde [`src/pages/index.astro`](src/pages/index.astro) admite selección múltiple (`multiple`), arrastrar y soltar (drag-and-drop) en `#pdf-dropzone` y cola acumulativa con carga secuencial para enlazar referencias cruzadas en Neo4j entre documentos del lote.
* Segmenta el documento en artículos/cláusulas atómicas (`norma-<slug>-art-<n>`).
* **Extracción Dinámica por Lotes con `gemini-3.6-flash`:** Procesa hasta 10 artículos (o 35.000 caracteres) por solicitud extrayendo **Entidades Ontológicas** y **Reglas Deónticas** (`OBLIGACION`, `PROHIBICION`, `PERMISION`, `SANCION_NULIDAD`), propagando cualquier error real sin generar reglas sintéticas falsas.
* **Compuerta SHACL Pre-Ingesta ([`src/lib/shacl/shapes.ttl`](src/lib/shacl/shapes.ttl)):** Valida `legal:OKFNodeShape` (el selector de vigencia `#pdf-status` en la UI permite probar la admisión de normas `Vigente` o el rechazo HTTP `422` para `Historica`).
* **Persistencia Neo4j Sin Colisiones ([`src/lib/neo4j/schema.js`](src/lib/neo4j/schema.js)):** Almacena nodos `LegalOKF` con embeddings de 384d, enlaces `[:CONCUERDA_CON]`, `ConceptoOntologico` y nodos `ReglaDeontica` con identificador único por artículo (`<okf_id>::<regla.id>`), limpiando aristas obsoletas al re-ingestar.

### 2. Pipeline Neuro-Simbólico de 6 Etapas ([`src/lib/gemini/agent.ts`](src/lib/gemini/agent.ts))
1. **Clasificador de Hechos:** Extrae sujetos, parte evaluada, rol jurídico, conductas, omisiones, resultados y defensas invocadas bajo esquema Zod estricto con `gemini-3.6-flash`.
2. **Motor Deóntico OPA ([`src/lib/opa/policies/legal_deontico.rego`](src/lib/opa/policies/legal_deontico.rego)):** Evalúa de forma determinista (0 tokens LLM) las reglas de las normas cargadas haciendo coincidir léxicamente `palabras_clave` o campos de la propia regla contra omisiones, conductas, cláusulas y resumen del caso. Deriva dinámicamente `nodos_okf_obligatorios`, `prelacion_kelsen` y `escenarios_contrafacticos` a partir únicamente de las normas y hallazgos activados.
3. **Recuperador Híbrido Neo4j ([`src/lib/neo4j/client.ts`](src/lib/neo4j/client.ts)):** Combina búsqueda vectorial (Hugging Face 384d), Full-Text BM25, nodos obligatorios de OPA y expansión Cypher (con respaldo controlado hacia nodos `Vigente` activos si los índices devolvieran cero candidatos).
4. **Validador SHACL + Autorreparación:** Valida `legal:LegalAnalysisShape` en RDF/Turtle; si faltan nodos exigidos por OPA, los recupera deterministamente desde Neo4j.
5. **Agente Exégeta (I–IV):** Redacta en un pase integral las 4 secciones del dictamen jurídico basándose estrictamente en los nodos vigentes recuperados y citándolos con `[okf_id]`. El visor en [`src/pages/index.astro`](src/pages/index.astro) renderiza el Markdown mediante `marked` e hidrata citas interactivas `[norma-...]`.
6. **Auditor Epistémico Post-Generación y Auto-Reparación ([`src/lib/shacl/validator.ts`](src/lib/shacl/validator.ts)):** Valida `legal:EpistemicAuditShape` verificando exclusivamente citas explícitas entre corchetes `[norma-...]` contra el subgrafo recuperado. Si falla (`passed === false`), ejecuta primero una normalización determinista de citas válidas sin corchetes (0 tokens LLM) y, si persiste el fallo, un **único pase dirigido de auto-reparación** ([`src/lib/prompts/epistemic-repair.md`](src/lib/prompts/epistemic-repair.md)), emitiendo estado `repaired` (`Reparado ✓`) si corrige o `failed` (`Alerta ✗`) si persiste la anomalía.

---

## 🧹 Borrar la Base de Datos y Dejar Todo en Blanco

En cualquier momento puedes reiniciar el sistema por completo (eliminando el 100% de nodos y relaciones en Neo4j, borrando `src/content/okf/*.md` y restaurando la interfaz en blanco):

* **Desde el Front-End (`http://localhost:4321`):**
  * **`Borrar Base de Datos y Dejar en Blanco`** (en el panel superior de Ingesta PDF).
  * **`Borrar Base`** (en la barra superior de estado).
  * **`Limpiar grafo`** (sobre el lienzo del grafo Neo4j OKF).
* **Desde la Terminal:**
  ```bash
  npm run db:clear
  ```

---

## 🛠️ Scripts Disponibles ([`package.json`](package.json))

| Comando | Descripción |
| :--- | :--- |
| `npm run dev` | Inicia Neo4j en Docker, inicializa esquema/índices, valida `./bin/opa` + `opa test` y levanta Astro SSR en `:4321`. |
| `npm run dev:astro` | Inicia únicamente el servidor Astro en modo desarrollo (auto-asegura `./bin/opa` al evaluar OPA). |
| `npm run build` | Compila la aplicación SSR de producción en `dist/`. |
| `npm run preview` | Ejecuta el servidor compilado (`dist/`). |
| `npm run db:up` | Levanta el contenedor `neo4j-data-legal` con `docker compose up -d`. |
| `npm run db:down` | Detiene el contenedor Neo4j. |
| `npm run db:logs` | Muestra logs en vivo de Neo4j. |
| `npm run db:seed` | Reconcilia índices de Neo4j y sincroniza los `.md` presentes en `src/content/okf/`. |
| `npm run db:clear` | Borra todos los nodos/relaciones en Neo4j y elimina `src/content/okf/*.md`. |
| `npm run opa:test` | Asegura `./bin/opa` y ejecuta los tests unitarios Rego v1. |

---

## 🔌 Endpoints de la API

| Método y Ruta | Archivo | Función |
| :--- | :--- | :--- |
| `POST /api/laws/upload` | [`src/pages/api/laws/upload.ts`](src/pages/api/laws/upload.ts) | Recibe uno o varios PDF (`multipart/form-data` en `file`/`files`) o JSON (`fileBase64` / `rawPdfText`), segmenta en artículos OKF, extrae ontología/deóntica, valida SHACL (`422` si rechaza) e indexa en Neo4j. |
| `GET /api/laws/catalog` | [`src/pages/api/laws/catalog.ts`](src/pages/api/laws/catalog.ts) | Devuelve todos los nodos `LegalOKF` y sus relaciones en Neo4j. |
| `DELETE /api/laws/catalog` | [`src/pages/api/laws/catalog.ts`](src/pages/api/laws/catalog.ts) | Ejecuta `MATCH (n) DETACH DELETE n`, elimina `src/content/okf/*.md` y revalida índices vacíos. |
| `POST /api/dictamen/stream` | [`src/pages/api/dictamen/stream.ts`](src/pages/api/dictamen/stream.ts) | Ejecuta en streaming NDJSON las 6 etapas del pipeline neuro-simbólico. |

---

## 📁 Estructura del Proyecto

```text
data_legal/
├── bin/opa                                 # Binario OPA local (auto-instalado, ignorado en Git)
├── scripts/
│   ├── dev.js                              # Orquestador de npm run dev
│   ├── seed-neo4j.js                       # Inicialización y sincronización Neo4j
│   ├── clear-db.js                         # CLI npm run db:clear
│   └── opa-test.js                         # Ejecutor de tests unitarios Rego v1
├── src/
│   ├── content.config.ts                   # Definición de colección Astro para fichas OKF
│   ├── content/okf/                        # Almacenamiento runtime de fichas .md (ignorado en Git)
│   ├── layouts/Layout.astro                # Layout HTML base con tema oscuro
│   ├── styles/global.css                   # Estilos Tailwind v4 y tipografía del dictamen
│   ├── lib/
│   │   ├── config.ts                       # Configuración unificada desde .env
│   │   ├── embeddings/huggingface.ts       # Extractor local @xenova/transformers (384d)
│   │   ├── gemini/agent.ts                 # Orquestador del pipeline neuro-simbólico (6 etapas)
│   │   ├── gemini/key-rotator.ts           # Rotador multi-clave Round-Robin + Failover + Hot-Reload
│   │   ├── neo4j/client.ts                 # Cliente Neo4j híbrido (Vector + BM25 + Cypher + Clear)
│   │   ├── neo4j/schema.js                 # Reconciliación compartida de esquema, índices y upsert
│   │   ├── okf/pdf-ingestor.ts             # Parser PDF/texto, segmentación atómica y lotes Gemini
│   │   ├── opa/binary.js                   # Resolutor e instalador autocontenido de ./bin/opa
│   │   ├── opa/evaluator.ts                # Evaluador Rego v1 y consulta de versión OPA
│   │   ├── opa/policies/
│   │   │   ├── legal_deontico.rego         # Matriz deóntica dinámica y contrafácticos
│   │   │   └── legal_deontico_test.rego    # Tests unitarios Rego v1
│   │   ├── prompts/                        # System prompts externalizados (.md) + loader hot-reload
│   │   │   ├── loader.ts
│   │   │   ├── fact-extractor.md
│   │   │   ├── dictamen-exegesis.md
│   │   │   ├── epistemic-repair.md
│   │   │   ├── deontic-batch-extractor.md
│   │   │   └── deontic-article-extractor.md
│   │   └── shacl/
│   │       ├── shapes.ttl                  # Restricciones SHACL (pre-ingesta, subgrafo, auditoría)
│   │       └── validator.ts                # Validador RDF/SHACL y auditor epistémico
│   └── pages/
│       ├── index.astro                     # Interfaz web completa, grafo SVG y borrado integral
│       └── api/
│           ├── dictamen/stream.ts          # Endpoint NDJSON de análisis en vivo
│           ├── laws/catalog.ts             # GET/DELETE del catálogo OKF en Neo4j
│           └── laws/upload.ts              # Ingesta PDF/JSON con compuerta SHACL
├── .env.example                            # Plantilla de variables de entorno
├── .gitignore                              # Exclusión de .env, /bin/, *.md de runtime y cachés
├── astro.config.mjs                        # Configuración Astro SSR (@astrojs/node + Tailwind)
├── docker-compose.yml                      # Neo4j 5.20 local (puertos 7475 HTTP / 7688 Bolt)
├── package.json                            # Dependencias y scripts
└── tsconfig.json                           # Configuración TypeScript
```
