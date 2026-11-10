# Sistema Neuro-Simbólico de Análisis Legal y Razonamiento Deóntico

Plataforma Fullstack construida sobre **Astro 5 SSR + Google GenAI (`gemini-3.6-flash`) + Embeddings Locales de Hugging Face (`Xenova/all-MiniLM-L6-v2`) + Neo4j Híbrido + Google OKF (Open Knowledge Format) + Open Policy Agent (OPA / Rego v1) + W3C SHACL**.

El sistema es **100% agnóstico de dominio y guiado estrictamente por documentos**: no posee normas preinstaladas ni reglas hardcodeadas; analiza exclusivamente el documento normativo en PDF que el usuario carga, extrayendo dinámicamente su **ontología** (sujetos, conceptos jurídicos) y su **matriz deóntica** (`OBLIGACION`, `PROHIBICION`, `PERMISION`, `SANCION_NULIDAD`).

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

### ¿Qué automatiza `npm run dev` (`scripts/dev.js`)?

1. **Neo4j Local (`docker compose up -d`):** Levanta el contenedor `neo4j-data-legal` (`neo4j:5.20.0-community`) exponiendo **Bolt en `7688`** y el **Browser Web en `http://localhost:7475`**.
2. **Esquema e Índices en Neo4j (`scripts/seed-neo4j.js` + `src/lib/neo4j/schema.js`):**
   * Reconcilia restricciones (`okf_id`, `ConceptoOntologico`, `ReglaDeontica`).
   * Elimina índices heredados o incompatibles si existieran y asegura el índice vectorial de **384 dimensiones** (`legal_normas_vector_index`, similitud coseno) y el índice léxico Full-Text BM25 (`legal_normas_fulltext_index`).
   * Sincroniza únicamente las normas `.md` existentes en `src/content/okf/` (inicialmente vacío si no se cargaron documentos).
3. **Motor OPA Autocontenido (`scripts/opa-test.js` + `src/lib/opa/binary.js`):**
   * Verifica o instala automáticamente el binario de **Open Policy Agent `v1.22.0`** dentro del directorio de la aplicación en **`./bin/opa`**.
   * Ejecuta los tests unitarios de Rego v1 (`src/lib/opa/policies/legal_deontico_test.rego`).
4. **Servidor Web Astro SSR:** Inicia la interfaz web y los endpoints de API en **`http://localhost:4321`**.

---

## 🔑 Configuración de Variables de Entorno (`.env`) y Seguridad

El archivo `.gitignore` bloquea por defecto `.env`, `.env.*` (excepto `.env.example`), `/bin/`, `node_modules/`, `dist/`, `.astro/` y cachés locales para evitar filtrar credenciales o subir binarios compilados al repositorio.

### Rotación Inteligente de API Keys de Gemini (`src/lib/gemini/key-rotator.ts`)

Puedes configurar una o múltiples claves para distribuir carga y tolerar límites diarios del Free Tier (`20 req/día` por clave):

```env
GEMINI_MODEL=gemini-3.6-flash
GEMINI_MAX_OUTPUT_TOKENS=32768

# Múltiples claves separadas por coma, punto y coma o salto de línea
GEMINI_API_KEY=clave_1, clave_2

# Alternativamente, variables numeradas individuales:
# GEMINI_API_KEY_1=clave_1
# GEMINI_API_KEY_2=clave_2
```

* **Balanceo *Round-Robin*:** Alterna las peticiones entre todas las claves activas.
* ***Failover* Automático:** Si una clave devuelve cuota diaria agotada (`429` / `RESOURCE_EXHAUSTED`), entra en *cooldown* calculado según `retryDelay` y conmuta instantáneamente a la siguiente clave disponible.
* **Resiliencia ante 503 y RPM:** Ante límites por minuto (`RPM`) espera el *cooldown* corto automáticamente; ante alta demanda transitoria (`503` / `UNAVAILABLE`) aplica *backoff* sin bloquear la última clave disponible.
* **Recarga en Caliente (*Hot-Reload*):** Si agregas o reemplazas claves en `.env`, el rotador recarga el archivo desde disco sin necesidad de reiniciar el servidor.

### Embeddings Locales de Hugging Face (`src/lib/embeddings/huggingface.ts`)

```env
HUGGINGFACE_EMBEDDING_MODEL=Xenova/all-MiniLM-L6-v2
HF_TOKEN=
```

* Se ejecutan **100% localmente** en Node.js mediante `@xenova/transformers` (ONNX Runtime, 384 dimensiones), sin invocar APIs remotas pagas ni consumir créditos de Hugging Face Inference Providers.

### Binario de OPA en el Directorio de la Aplicación

```env
OPA_BIN_PATH=./bin/opa
OPA_SERVER_URL=
```

* Tanto la aplicación (`src/lib/config.ts`) como los scripts (`scripts/opa-test.js`) resuelven OPA priorizando **`./bin/opa`** dentro del directorio raíz del proyecto (descargándolo o copiándolo automáticamente la primera vez si falta).

---

## 📄 Flujo de Trabajo y Arquitectura

### 1. Ingesta Dinámica de PDF y Atomización OKF (`src/lib/okf/pdf-ingestor.ts`)
* Sube un documento PDF desde el panel **Ingesta Dinámica de Normas**.
* El ingestor extrae el texto y segmenta el cuerpo legal por artículos/cláusulas atómicas (`norma-<slug>-art-<n>`).
* **Extracción por Lotes con `gemini-3.6-flash`:** Procesa hasta 10 artículos (o 35.000 caracteres) por solicitud para extraer sus **Entidades Ontológicas** y **Reglas Deónticas** (`OBLIGACION`, `PROHIBICION`, `PERMISION`, `SANCION_NULIDAD`), minimizando consumo de cuota y RPM.
* **Compuerta SHACL Pre-Ingesta (`src/lib/shacl/shapes.ttl`):** Valida `legal:OKFNodeShape` antes de guardar el archivo `.md` en `src/content/okf/` e indexarlo con su embedding local de 384d y relaciones `[:CONCUERDA_CON]` en Neo4j.

### 2. Pipeline Neuro-Simbólico de 6 Etapas (`src/lib/gemini/agent.ts`)
1. **Clasificador de Hechos:** Extrae sujetos, rol evaluado, conductas, omisiones, resultados y defensas invocadas bajo esquema estricto Zod usando `gemini-3.6-flash`.
2. **Motor Deóntico OPA (`legal_deontico.rego`):** Evalúa deterministamente (0 tokens LLM) la matriz deóntica de las normas cargadas frente a los hechos y omisiones.
3. **Recuperador Híbrido Neo4j:** Combina búsqueda vectorial (Hugging Face 384d), Full-Text BM25, nodos obligatorios activados por OPA y expansión Cypher del vecindario.
4. **Validador SHACL + Autorreparación:** Valida `legal:LegalAnalysisShape` sobre el subgrafo en RDF/Turtle; si faltan nodos exigidos por OPA, los recupera automáticamente desde Neo4j.
5. **Agente Exégeta (I–IV):** Redacta en un pase integral las 4 secciones del dictamen jurídico basándose estrictamente en los nodos vigentes recuperados y citándolos como `[okf_id]`.
6. **Auditor Epistémico Post-Generación:** Valida `legal:EpistemicAuditShape` verificando que el 100% de las citas `[norma-...]` existan en el subgrafo recuperado (cero citas alucinadas).

---

## 🧹 Borrar la Base de Datos y Dejar Todo en Blanco

En cualquier momento puedes reiniciar el sistema por completo (eliminando el 100% de los nodos y relaciones en Neo4j, borrando todas las fichas `.md` en `src/content/okf/` y restaurando toda la interfaz en blanco):

* **Desde el Front-End (`http://localhost:4321`):**
  Haz clic en cualquiera de los botones de borrado disponibles en la interfaz:
  * **`Borrar Base de Datos y Dejar en Blanco`** (en el panel superior de Ingesta PDF).
  * **`Borrar Base`** (en la barra superior de estado).
  * **`Limpiar grafo`** (sobre el lienzo del grafo Neo4j OKF).
  Esto ejecuta `DELETE /api/laws/catalog` y restablece el grafo, el inspector de nodos, los formularios, las 6 tarjetas del pipeline, el visor de dictamen y las pestañas OPA/SHACL.
* **Desde la Terminal:**
  ```bash
  npm run db:clear
  ```

---

## 🛠️ Scripts Disponibles (`package.json`)

| Comando | Descripción |
| :--- | :--- |
| `npm run dev` | Inicia Neo4j en Docker, inicializa esquema/índices, valida `./bin/opa` + `opa test` y levanta Astro SSR en `:4321`. |
| `npm run dev:astro` | Inicia únicamente el servidor Astro en modo desarrollo. |
| `npm run build` | Compila la aplicación SSR de producción en `dist/`. |
| `npm run preview` | Ejecuta el servidor compilado (`dist/`). |
| `npm run db:up` | Levanta el contenedor `neo4j-data-legal` con `docker compose up -d`. |
| `npm run db:down` | Detiene el contenedor Neo4j. |
| `npm run db:logs` | Muestra logs en vivo de Neo4j. |
| `npm run db:seed` | Reconcilia índices de Neo4j y sincroniza los `.md` presentes en `src/content/okf/`. |
| `npm run db:clear` | Borra todos los nodos/relaciones en Neo4j y elimina las fichas `.md` de `src/content/okf/`. |
| `npm run opa:test` | Asegura `./bin/opa` y ejecuta los tests unitarios de políticas Rego v1. |

---

## 🔌 Endpoints de la API

| Método y Ruta | Función |
| :--- | :--- |
| `POST /api/laws/upload` | Recibe un PDF (`multipart/form-data` o JSON), lo segmenta en artículos OKF, extrae ontología/deóntica, valida SHACL e indexa en Neo4j. |
| `GET /api/laws/catalog` | Devuelve todos los nodos `LegalOKF` vigentes y sus relaciones en Neo4j. |
| `DELETE /api/laws/catalog` | Ejecuta `MATCH (n) DETACH DELETE n` en Neo4j, elimina los archivos `src/content/okf/*.md` y revalida los índices vacíos. |
| `POST /api/dictamen/stream` | Ejecuta en streaming NDJSON las 6 etapas del pipeline neuro-simbólico sobre el caso planteado. |

---

## 📁 Estructura del Proyecto

```text
data_legal/
├── bin/opa                      # Binario local de OPA v1.22.0 (auto-instalado, ignorado en Git)
├── scripts/
│   ├── dev.js                   # Orquestador único de npm run dev
│   ├── seed-neo4j.js            # Inicialización y sincronización Neo4j
│   ├── clear-db.js              # Script CLI npm run db:clear
│   └── opa-test.js              # Ejecutor de tests unitarios Rego v1
├── src/
│   ├── content/okf/             # Fichas atómicas OKF (.md) generadas al subir PDFs
│   ├── lib/
│   │   ├── config.ts            # Configuración unificada desde .env
│   │   ├── embeddings/huggingface.ts  # Extractor local @xenova/transformers (384d)
│   │   ├── gemini/agent.ts      # Orquestador del pipeline neuro-simbólico (6 etapas)
│   │   ├── gemini/key-rotator.ts # Rotador multi-clave Round-Robin + Failover + Hot-Reload
│   │   ├── neo4j/client.ts      # Cliente Neo4j híbrido (Vector + BM25 + Cypher + Clear)
│   │   ├── neo4j/schema.js      # Reconciliación compartida de índices Neo4j
│   │   ├── okf/pdf-ingestor.ts  # Parser PDF, segmentación atómica y extracción en lotes
│   │   ├── opa/binary.js        # Resolutor e instalador de ./bin/opa
│   │   ├── opa/evaluator.ts     # Evaluador Rego v1 de matriz deóntica
│   │   ├── opa/policies/        # legal_deontico.rego y legal_deontico_test.rego
│   │   └── shacl/               # shapes.ttl y validador/auditor epistémico RDF
│   └── pages/
│       ├── index.astro          # Interfaz web completa + visor de grafo + botón de borrado
│       └── api/                 # Endpoints REST y streaming NDJSON
├── .env.example                 # Plantilla documentada de variables de entorno
├── .gitignore                   # Protección de .env, /bin/, dist/ y cachés
├── docker-compose.yml           # Neo4j 5.20 local (puertos 7475 HTTP / 7688 Bolt)
└── package.json
```
