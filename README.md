# Sistema Neuro-Simbólico de Análisis Legal y Razonamiento Deóntico

Plataforma Fullstack en **Astro SSR + Google GenAI (Gemini 3.6 Flash) + Embeddings de Hugging Face (all-MiniLM-L6-v2) + Neo4j Híbrido + Google OKF (Open Knowledge Format) + Open Policy Agent (OPA / Rego v1) + W3C SHACL**.

El sistema es **100% agnóstico de dominio y guiado por documentos**: analiza estrictamente el documento normativo en PDF que el usuario carga, extrayendo de forma dinámica tanto su **ontología** (sujetos, conceptos jurídicos) como su **matriz deóntica** (obligaciones, prohibiciones, permisiones y consecuencias de nulidad/sanción).

---

## 🚀 Inicio Rápido con un Único Comando (`npm run dev`)

Todo el ciclo de vida del sistema está automatizado dentro de **`npm run dev`** (`scripts/dev.js`). Al ejecutarlo:

1. **Levanta automáticamente Neo4j local (`neo4j-data-legal`)** vía `docker compose up -d` en el puerto Bolt `7688` y HTTP Browser `7475`.
2. **Inicializa el esquema y recrea los índices en Neo4j**:
   - Índice vectorial de 384 dimensiones con el modelo local de **Hugging Face** (`Xenova/all-MiniLM-L6-v2`).
   - Índice léxico Full-Text BM25 (`legal_normas_fulltext_index`).
   - Restricciones ontológicas sobre nodos `LegalOKF`, `ConceptoOntologico` y `ReglaDeontica`.
3. **Ejecuta los tests unitarios del motor deóntico OPA (Rego v1)** verificando el razonamiento formal sobre obligaciones, prohibiciones, permisiones y nulidades.
4. **Inicia el servidor Fullstack Astro SSR** en `http://localhost:4321`.

```bash
# 1. Instalar dependencias (primera vez)
npm install

# 2. Levantar toda la arquitectura (Neo4j + Hugging Face Embeddings + OPA Test + Astro SSR)
npm run dev
```

Una vez iniciado, abre **`http://localhost:4321`** en tu navegador.

---

## 📄 Modo de Operación: Basado Estrictamente en lo que Cargues

1. **Base de Conocimiento Limpia:** El sistema no posee leyes ni normas preinstaladas o hardcodeadas.
2. **Carga de Documento Normativo en PDF:**
   - Desde el panel superior, sube cualquier documento en PDF (ley, reglamento, términos contractuales, estatuto, código, etc.).
   - El ingestor (`src/lib/okf/pdf-ingestor.ts`) segmenta automáticamente cada artículo/cláusula como una unidad atómica OKF.
   - **Extracción Dinámica con Gemini 3.6 Flash:** Para cada unidad, el modelo extrae:
     - **Entidades Ontológicas:** Sujetos de derecho, conceptos jurídicos regulados, definiciones y roles.
     - **Matriz Deóntica:** Reglas deónticas con sus modalidades:
       - `OBLIGACION`: Deberes positivos de hacer o dar.
       - `PROHIBICION`: Deberes negativos de no hacer o conductas vedadas.
       - `PERMISION`: Facultades y derechos subjetivos reconocidos.
       - `SANCION_NULIDAD`: Ineficacias, nulidades o sanciones ante inobservancia.
   - **Compuerta SHACL Pre-Ingesta (`legal:OKFNodeShape`):** Valida la conformidad estructural del artículo antes de persistir en disco y Neo4j.
3. **Planteo del Caso Fáctico:**
   - Escribe en lenguaje natural la situación de hecho, partes involucradas, conductas desplegadas y cláusulas o defensas invocadas.
4. **Ejecución del Pipeline Neuro-Simbólico de 6 Etapas:**
   - **Etapa 1 (Clasificador de Hechos):** Extrae mediante esquema estricto Zod los hechos, partes, conductas y omisiones con Gemini 3.6 Flash.
   - **Etapa 2 (Motor Deóntico OPA):** Evalúa la matriz deóntica en Rego v1 de forma determinista (0 tokens LLM), contrastando omisiones contra obligaciones y conductas contra prohibiciones.
   - **Etapa 3 (Recuperador Híbrido Neo4j):** Recupera los nodos normativos mediante búsqueda vectorial (Hugging Face MiniLM-L6-v2), BM25 y expansión relacional Cypher.
   - **Etapa 4 (Validador SHACL):** Verifica `legal:LegalAnalysisShape` y aplica autorreparación si faltan nodos requeridos por OPA.
   - **Etapa 5 (Agente Exégeta):** Gemini 3.6 Flash redacta las 4 secciones del dictamen basándose estricta y exclusivamente en los nodos recuperados y citando `[okf_id]`.
   - **Etapa 6 (Auditor Epistémico):** SHACL audita que todas las citas normativas pertenezcan al grafo Neo4j del documento y valida 0 alucinaciones.

---

## 🧠 Características Técnicas

- **Modelo de Razonamiento:** `gemini-3.6-flash` configurado de forma estricta. Cero modelos fallback.
- **Rotación Inteligente de API Keys:** Pool dinámico de claves con balanceo *Round-Robin* y *Failover automático*. Si una clave agota su cuota diaria (429 / `RESOURCE_EXHAUSTED`), entra en *cooldown* y el sistema conmuta instantáneamente a la siguiente clave activa sin interrumpir el dictamen.
- **Embeddings:** `Xenova/all-MiniLM-L6-v2` (384 dimensiones) ejecutado localmente con ONNX Runtime (`@xenova/transformers`).
- **Motor Deóntico Simbólico:** Open Policy Agent (`legal_deontico.rego`, paquete `data.legal.deontico`).
- **Validación Estructural y Epistémica:** W3C SHACL (`rdf-validate-shacl`) bajo el espacio de nombres `http://antigravity.ai/ontologia/legal#`.
- **Base de Datos Gráfica:** Neo4j 5.20 en Docker (`bolt://localhost:7688`).

---

## 🔑 Configuración de Claves de Gemini en `.env`

Puedes configurar una o múltiples claves API en el archivo `.env` para multiplicar tu cuota:

```env
# Claves separadas por coma o punto y coma
GEMINI_API_KEY=AIzaSyA..., AIzaSyB...

# O variables individuales numeradas
# GEMINI_API_KEY_1=AIzaSyA...
# GEMINI_API_KEY_2=AIzaSyB...
```

* El sistema detecta automáticamente nuevas claves agregadas al archivo `.env` en caliente sin necesidad de reiniciar el servidor.
* Los logs muestran enmascaradas las claves utilizadas (ej. `AQ.Ab8...ecxvJg`) y el estado del pool.
