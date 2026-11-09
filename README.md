# Sistema Neuro-Simbólico de Ingeniería Legal y Ejercicio Profesional (FIUBA)

Plataforma Fullstack en **Astro SSR + Google GenAI (Gemini 3.8 Flash / Gemini 3.6 Flash) + Embeddings de Hugging Face (all-MiniLM-L6-v2) + Neo4j Híbrido + Google OKF (Open Knowledge Format) + Open Policy Agent (OPA / Rego v1) + W3C SHACL** diseñada para todas las especialidades de la Facultad de Ingeniería de la Universidad de Buenos Aires (**Civil, Industrial, Informática, Electrónica, Mecánica, Electricista, Química y Naval**).

---

## 🚀 Inicio Rápido con un Único Comando (`npm run dev`)

Todo el ciclo de vida del sistema está automatizado dentro de **`npm run dev`** (`scripts/dev.js`). Al ejecutarlo:

1. **Levanta automáticamente Neo4j local (`neo4j-data-legal`)** vía `docker compose up -d` en el puerto Bolt `7688` y HTTP Browser `7475`.
2. **Inicializa el esquema y recrea el índice vectorial de 384 dimensiones** con el modelo de **Hugging Face** (`Xenova/all-MiniLM-L6-v2`) y el índice léxico BM25 (`fiuba_legal_okf_fulltext_index`), sincronizando todos los nodos atómicos `.md` de `src/content/okf/` con sus aristas normativas.
3. **Ejecuta los tests unitarios del motor deóntico OPA (Rego v1)** verificando las reglas de incumbencias, colegiación y orden público.
4. **Inicia el servidor Fullstack Astro SSR** en `http://localhost:4321`.

```bash
# Instalar dependencias (primera vez)
npm install

# Levantar toda la arquitectura (Neo4j + Embeddings Hugging Face + OPA Test + Astro SSR)
npm run dev
```

Una vez iniciado, abrí **`http://localhost:4321`** en tu navegador.

---

## 🧠 Aspectos Clave de la Arquitectura Implementada

### 1. Embeddings de Hugging Face (`384 dimensiones`)
- **Motor de Embeddings (`src/lib/embeddings/huggingface.ts`):** Utiliza el modelo estándar de la industria **`Xenova/all-MiniLM-L6-v2`** (o `sentence-transformers/all-MiniLM-L6-v2`).
- **Ejecución Local de Alta Velocidad (`@xenova/transformers`):** Corre 100% en local en Node.js mediante ONNX runtime sin cuotas de tokens, latencia externa ni dependencias de conexión.
- **Soporte de Hugging Face API (`@huggingface/inference`):** Si se define `HF_TOKEN` en `.env`, permite alternar con la API remota de inferencia.
- **Índice Vectorial en Neo4j:** Configurado con cardinalidad exacta de `384` dimensiones (`vector.similarity_function: 'cosine'`).

### 2. Cero Modelos Fallback (Sin Fallback Models)
- El sistema utiliza exclusivamente el modelo de razonamiento configurado en **`GEMINI_MODEL`** (por defecto `gemini-3.8-flash` o `gemini-3.6-flash`).
- **Determinismo Neuro-Simbólico:** Sin parámetros de muestreo deprecados (`temperature`, `top_p`, `top_k` eliminados de la API de Gemini). El determinismo está garantizado por el anclaje simbólico provisto por **OPA**, **SHACL** y esquemas estructurados **Zod**.
- Si la llamada al modelo configurado encuentra un error, se propaga directamente con diagnóstico exacto sin conmutar silenciosamente a modelos de menor capacidad.

```text
[Situación / Caso de Ingeniería o Subida de Ley en PDF]
       │
       ▼
┌──────────────────────────────────────────────────────────┐
│ 1. Agente Clasificador de Hechos (Gemini + Zod Schema)   │
│    Extrae: Rama FIUBA, Rol, Jurisdicción, Hechos, Daños  │
└──────┬───────────────────────────────────────────────────┘
       │ JSON Estructurado (Sin temperature/top_p)
       ▼
┌──────────────────────────────────────────────────────────┐
│ 2. Motor Deóntico de Políticas (OPA / Rego v1)           │
│    Evalúa incumbencias (Ley 19.587, Dec. 6070/58,        │
│    Ley 10.416 PBA, Art. 1276 CCyCN) y Kelsen sin LLM.    │
└──────┬───────────────────────────────────────────────────┘
       │ Permisos, Nulidades, Nodos Obligatorios y Filtros
       ▼
┌──────────────────────────────────────────────────────────┐
│ 3. Agente Recuperador Híbrido (Neo4j + Estándar OKF)     │
│    Hugging Face Vector (384d) + BM25 + Expansión Cypher  │
└──────┬───────────────────────────────────────────────────┘
       │ Subgrafo Normativo Vigente + Aristas Explícitas
       ▼
┌──────────────────────────────────────────────────────────┐
│ 4. Validador Ontológico Estructural (W3C SHACL)          │
│    ¿El subgrafo cubre LegalAnalysisShape?                │
│    ──[NO]──> Autorreparación Cypher en Neo4j             │
└──────┬───────────────────────────────────────────────────┘
       │ [SÍ] Esqueleto Argumental Validado (RDF / Turtle)
       ▼
┌──────────────────────────────────────────────────────────┐
│ 5. Agente Exégeta / Redactor de Largo Aliento            │
│    Redacción iterativa extensa por Capítulos (I a IV)    │
│    obedeciendo directivas OPA y citando [okf_id].        │
└──────┬───────────────────────────────────────────────────┘
       │ Documento Extenso Compilado en Streaming
       ▼
┌──────────────────────────────────────────────────────────┐
│ 6. Auditor Epistémico Post-Generación (SHACL + OPA)      │
│    Verifica trazabilidad de citas contra el grafo Neo4j. │
└──────────────────────────────────────────────────────────┘
```

---

## 📄 Ingesta de Leyes por PDF desde el Frontend (`PDF -> OKF -> SHACL -> Neo4j`)

Desde el panel superior **"Subir Ley en PDF (OKF + SHACL)"** en `http://localhost:4321` (endpoint `POST /api/laws/upload`):

1. **Extracción y Segmentación Atómica Normativa (`src/lib/okf/pdf-ingestor.ts`):**
   - Extrae el texto del PDF subido mediante `pdf-parse` y segmenta atómicamente por `ARTÍCULO` conservando todos sus incisos como una unidad atómica **Google OKF**.
2. **Descubrimiento Dinámico de Referencias Cruzadas:**
   - Detecta menciones a normas existentes en el catálogo de Neo4j y genera aristas explícitas `[:CONCUERDA_CON]`, `[:PROHIBE_DISPENSA_EN]`, `[:REGLAMENTA_A]` y `[:APLICA_A_ESPECIALIDAD]`.
3. **Compuerta SHACL Pre-Ingesta (`fiuba:OKFNodeShape`):**
   - Valida en memoria el nodo RDF Turtle contra `src/lib/shacl/shapes.ttl`.
   - Si se intenta subir una norma con estado `Historica` (derogada), **SHACL rechaza determinísticamente la ingesta** (`sh:hasValue "Vigente"`) impidiendo que ingrese a Neo4j.
4. **Persistencia Dual (Markdown OKF + Neo4j):**
   - Guarda el archivo `.md` con Frontmatter YAML en `src/content/okf/`, calcula su vector de 384 dimensiones con **Hugging Face** y lo inserta en Neo4j.

---

## ⚖️ Detalle de los Componentes Simbólicos y Agénticos

### A. Motor Deóntico en OPA (`src/lib/opa/policies/fiuba_legal.rego`)
Codifica en **Rego v1** las matrices de decisión legal:
- **Jurisdicción y Colegiación:** `Decreto-Ley 6070/58` en CABA/Nacional vs. `Ley 10.416 CIPBA` y `Ley 12.490 CAAITBA` en PBA.
- **Control de Subcontratistas:** *Culpa in eligendo*, *culpa in vigilando* (`Art. 1274 inc. c CCyCN`) y falta ética (`Dec. 1099/84`) por subcontratistas sin matrícula habilitante verificada.
- **Orden Público Contractual:** Nulidad absoluta de cláusulas de dispensa de responsabilidad por ruina (`Art. 1276 CCyCN`).
- **Incumbencias y Actividades Reservadas:** `Art. 43 Ley 24.521` y `Res. ME 1232/01` (ej. exclusión de Alta Tensión a Ingeniería Industrial).
- **Exclusión de Defensa del Consumidor:** Inaplicabilidad de la `Ley 24.240` al profesional liberal (`Art. 2 LDC`).
- **Caducidad Decenal:** Cómputo de garantía decenal (`Art. 1275 CCyCN`) y prescripción anual (`Art. 2564 inc. c CCyCN`).

### B. Validador Ontológico SHACL (`src/lib/shacl/shapes.ttl` y `validator.ts`)
- **`fiuba:OKFNodeShape`:** Controla la pre-ingesta de normas desde PDF.
- **`fiuba:LegalAnalysisShape`:** Exige que el subgrafo previo a la redacción posea `NormaFondo`, `PrincipioDeResponsabilidad`, `MarcoEjercicioProfesional`, `EticaProfesional` y todos los nodos obligatorios de OPA. Si falta alguno, ejecuta autorreparación Cypher en Neo4j.
- **`fiuba:EpistemicAuditShape`:** Audita post-generación que toda cita legal del dictamen tenga trazabilidad en el subgrafo de Neo4j y no contenga citas alucinadas (`sh:maxCount 0` para `fiuba:hasHallucinatedCitation`).

---

## 🛠️ Comandos Disponibles

| Comando | Descripción |
| :--- | :--- |
| `npm run dev` | **Comando Todo-en-Uno:** Levanta Neo4j en Docker, indexa embeddings Hugging Face (384d), corre los tests de OPA e inicia Astro SSR en `http://localhost:4321`. |
| `npm run db:up` | Levanta únicamente el contenedor local `neo4j-data-legal` (`bolt://localhost:7688`). |
| `npm run db:seed` | Sincroniza y re-indexa los archivos OKF en Neo4j con Hugging Face. |
| `npm run opa:test` | Ejecuta los tests unitarios sobre las políticas Rego en `src/lib/opa/policies/`. |
| `npm run build` | Compila la aplicación Astro SSR para producción en `./dist`. |

---

## ⚙️ Variables de Entorno (`.env`)

```env
# Modelo Gemini (Google GenAI) - Sin modelo fallback
GEMINI_API_KEY=tu_clave_gemini
GEMINI_MODEL=gemini-3.8-flash
GEMINI_MAX_OUTPUT_TOKENS=32768

# Embeddings de Hugging Face (all-MiniLM-L6-v2 de 384 dimensiones)
HF_TOKEN=tu_token_huggingface_opcional
HUGGINGFACE_EMBEDDING_MODEL=Xenova/all-MiniLM-L6-v2

# Neo4j Local Graph Database (Contenedor propio neo4j-data-legal)
NEO4J_URI=bolt://localhost:7688
NEO4J_USER=neo4j
NEO4J_PASSWORD=password
NEO4J_VECTOR_DIMENSIONS=384

# Open Policy Agent (OPA)
OPA_BIN_PATH=/home/dracero/.local/bin/opa
```
