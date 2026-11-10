import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { GoogleGenAI } from '@google/genai';

export interface GeminiKeyStatus {
  key: string;
  masked: string;
  status: 'ACTIVE' | 'EXHAUSTED' | 'RATE_LIMITED' | 'INVALID';
  retryAfter: number | null; // Timestamp ms
  successCount: number;
  failCount: number;
  lastUsed: number;
  lastError: string | null;
}

export class GeminiKeyRotator {
  private keyPool: Map<string, GeminiKeyStatus> = new Map();
  private roundRobinIndex = 0;
  private lastEnvCheck = 0;

  constructor() {
    this.refreshKeysFromEnv();
  }

  /**
   * Enmascara una clave para logs seguros: ej. 'AQ.Ab8...ecxvJg'
   */
  public static maskKey(key: string): string {
    if (!key) return '(vacía)';
    if (key.length <= 12) return '***';
    return `${key.slice(0, 6)}...${key.slice(-6)}`;
  }

  /**
   * Lee y sincroniza claves desde process.env y directamente desde el archivo .env
   */
  public refreshKeysFromEnv(): void {
    const rawKeys: string[] = [];

    // 1. Recargar archivo .env en disco si existe
    try {
      const envPath = path.resolve(process.cwd(), '.env');
      if (fs.existsSync(envPath)) {
        const envContent = fs.readFileSync(envPath, 'utf-8');
        const parsed = dotenv.parse(envContent);
        if (parsed.GEMINI_API_KEY) rawKeys.push(parsed.GEMINI_API_KEY);
        if (parsed.GEMINI_API_KEYS) rawKeys.push(parsed.GEMINI_API_KEYS);
        if (parsed.GOOGLE_API_KEY) rawKeys.push(parsed.GOOGLE_API_KEY);
        if (parsed.GOOGLE_API_KEYS) rawKeys.push(parsed.GOOGLE_API_KEYS);
        for (const [k, v] of Object.entries(parsed)) {
          if (/^GEMINI_API_KEY_\d+$/i.test(k) && v) {
            rawKeys.push(v);
          }
        }
      }
    } catch {}

    // 2. Revisar variables en process.env
    if (process.env.GEMINI_API_KEY) rawKeys.push(process.env.GEMINI_API_KEY);
    if (process.env.GEMINI_API_KEYS) rawKeys.push(process.env.GEMINI_API_KEYS);
    if (process.env.GOOGLE_API_KEY) rawKeys.push(process.env.GOOGLE_API_KEY);
    if (process.env.GOOGLE_API_KEYS) rawKeys.push(process.env.GOOGLE_API_KEYS);

    for (const [k, v] of Object.entries(process.env)) {
      if (/^GEMINI_API_KEY_\d+$/i.test(k) && v) {
        rawKeys.push(v);
      }
    }

    // 3. Separar por comas, puntos y comas, o saltos de línea
    const extractedKeys: string[] = [];
    for (const raw of rawKeys) {
      const parts = raw.split(/[\r\n,;]+/);
      for (const p of parts) {
        const clean = p.trim().replace(/^["']|["']$/g, '');
        if (clean.length > 10 && !extractedKeys.includes(clean)) {
          extractedKeys.push(clean);
        }
      }
    }

    // 4. Actualizar o insertar en el pool preservando estadísticas previas
    const now = Date.now();
    for (const key of extractedKeys) {
      if (!this.keyPool.has(key)) {
        this.keyPool.set(key, {
          key,
          masked: GeminiKeyRotator.maskKey(key),
          status: 'ACTIVE',
          retryAfter: null,
          successCount: 0,
          failCount: 0,
          lastUsed: 0,
          lastError: null,
        });
      }
    }

    this.lastEnvCheck = now;
  }

  /**
   * Obtiene todas las claves configuradas (activas o en cooldown)
   */
  public getAllKeys(): GeminiKeyStatus[] {
    // Si pasaron más de 30 segundos, refrescar por si el usuario editó .env
    if (Date.now() - this.lastEnvCheck > 30000) {
      this.refreshKeysFromEnv();
    }
    return Array.from(this.keyPool.values());
  }

  /**
   * Obtiene las claves actualmente disponibles para operar
   */
  public getAvailableKeys(): GeminiKeyStatus[] {
    const all = this.getAllKeys();
    const now = Date.now();

    return all.filter((entry) => {
      if (entry.status === 'ACTIVE') return true;
      if (entry.retryAfter && now >= entry.retryAfter) {
        // Cooldown superado, rehabilitar clave
        entry.status = 'ACTIVE';
        entry.retryAfter = null;
        entry.lastError = null;
        console.log(`[Gemini Rotator] Clave ${entry.masked} rehabilitada tras finalizar cooldown.`);
        return true;
      }
      return false;
    });
  }

  /**
   * Obtiene la siguiente clave activa mediante Round-Robin
   */
  public getNextActiveKey(): GeminiKeyStatus {
    const available = this.getAvailableKeys();
    if (available.length === 0) {
      const total = this.getAllKeys();
      if (total.length === 0) {
        throw new Error(
          'No hay ninguna clave de Gemini configurada. Configure GEMINI_API_KEY en el archivo .env.'
        );
      }

      // Detalle de los cooldowns de cada clave
      const details = total
        .map((k) => {
          const waitMins = k.retryAfter ? Math.max(1, Math.round((k.retryAfter - Date.now()) / 60000)) : 0;
          return `${k.masked}: ${k.status} (espera aprox. ${waitMins} min)`;
        })
        .join(', ');

      throw new Error(
        `Todas las claves API de Gemini (${total.length} configuradas) han agotado su cuota o están en cooldown temporal. [${details}]. Ingrese una nueva clave API en .env para continuar de inmediato.`
      );
    }

    const item = available[this.roundRobinIndex % available.length];
    this.roundRobinIndex = (this.roundRobinIndex + 1) % available.length;
    item.lastUsed = Date.now();
    return item;
  }

  /**
   * Marca una clave como agotada (cuota 429 RESOURCE_EXHAUSTED)
   */
  public markExhausted(key: string, errorMsg: string, cooldownMs = 60 * 60 * 1000): void {
    const entry = this.keyPool.get(key);
    if (!entry) return;

    entry.status = 'EXHAUSTED';
    entry.failCount++;
    entry.lastError = errorMsg;

    // Intentar extraer retryDelay si Google lo indicó (ej. "retry in 7h41m..." o "retryDelay: 27709s")
    let retryDuration = cooldownMs;
    const retrySecMatch = errorMsg.match(/retryDelay["']?:\s*["']?(\d+)s/i) || errorMsg.match(/in\s+(\d+)s/i);
    if (retrySecMatch && retrySecMatch[1]) {
      retryDuration = (parseInt(retrySecMatch[1], 10) + 10) * 1000;
    }

    entry.retryAfter = Date.now() + retryDuration;
    console.warn(
      `[Gemini Rotator] ⚠️ Clave ${entry.masked} agotó su cuota (RESOURCE_EXHAUSTED). Entrando en cooldown de ${Math.round(retryDuration / 60000)}m. Rotando automáticamente a otra clave...`
    );
  }

  /**
   * Marca una clave con limitación de tasa transitoria (RPM o 503 Overloaded)
   */
  public markRateLimited(key: string, errorMsg: string, cooldownSec = 20): void {
    const entry = this.keyPool.get(key);
    if (!entry) return;

    entry.status = 'RATE_LIMITED';
    entry.failCount++;
    entry.lastError = errorMsg;
    entry.retryAfter = Date.now() + cooldownSec * 1000;
    console.warn(
      `[Gemini Rotator] ⏳ Clave ${entry.masked} con limitación transitoria. Pausada por ${cooldownSec}s.`
    );
  }

  /**
   * Marca éxito en la invocación de una clave
   */
  public markSuccess(key: string): void {
    const entry = this.keyPool.get(key);
    if (entry) {
      entry.status = 'ACTIVE';
      entry.successCount++;
      entry.retryAfter = null;
      entry.lastError = null;
    }
  }

  /**
   * Ejecuta una llamada a Gemini rotando automáticamente de clave ante cualquier error de cuota o rate-limit.
   */
  public async executeWithRotation<T>(
    operation: (client: GoogleGenAI, key: string, masked: string) => Promise<T>,
    operationName = 'Invocación Gemini'
  ): Promise<T> {
    const totalKeys = this.getAllKeys();
    if (totalKeys.length === 0) {
      throw new Error(
        'Falta configurar GEMINI_API_KEY en el archivo .env para ejecutar llamadas a Gemini.'
      );
    }

    const triedKeys = new Set<string>();
    const maxAttempts = Math.max(totalKeys.length * 2, 4);

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let keyEntry: GeminiKeyStatus;
      try {
        keyEntry = this.getNextActiveKey();
      } catch (err: any) {
        // Si no hay claves activas pero alguna ya fue probada, arrojar el resumen
        throw new Error(
          `[Gemini Rotator] No hay claves disponibles para '${operationName}': ${err.message}`
        );
      }

      triedKeys.add(keyEntry.key);
      const client = new GoogleGenAI({ apiKey: keyEntry.key });

      try {
        const result = await operation(client, keyEntry.key, keyEntry.masked);
        this.markSuccess(keyEntry.key);
        return result;
      } catch (err: any) {
        const errMsg = String(err.message || err);
        const errStatus = err.status || err.code;

        const isQuotaExceeded =
          errStatus === 429 ||
          errMsg.includes('RESOURCE_EXHAUSTED') ||
          errMsg.includes('Quota exceeded') ||
          errMsg.includes('exceeded your current quota') ||
          errMsg.includes('requests per day limit exceeded');

        const isTransientOverload =
          errStatus === 503 ||
          errMsg.includes('503') ||
          errMsg.includes('high demand') ||
          errMsg.includes('UNAVAILABLE') ||
          errMsg.includes('overloaded');

        if (isQuotaExceeded) {
          this.markExhausted(keyEntry.key, errMsg);
          // Si quedan otras claves sin probar o disponibles, reintentar de inmediato con la siguiente
          const remainingAvailable = this.getAvailableKeys();
          if (remainingAvailable.length > 0) {
            console.log(
              `[Gemini Rotator] Rotando inmediatamente a la siguiente clave disponible (${remainingAvailable.length} restantes)...`
            );
            continue;
          }
        } else if (isTransientOverload) {
          this.markRateLimited(keyEntry.key, errMsg, 15);
          const remainingAvailable = this.getAvailableKeys();
          if (remainingAvailable.length > 0) {
            console.log(
              `[Gemini Rotator] Servidor sobrecargado en clave ${keyEntry.masked}. Intentando con clave alternativa...`
            );
            continue;
          }
          // Si es la única clave, pausar brevemente y reintentar
          const delay = Math.min(attempt * 2000, 8000);
          console.warn(`[Gemini Rotator] Esperando ${delay}ms por alta demanda global...`);
          await new Promise((resolve) => setTimeout(resolve, delay));
          continue;
        }

        // Si es otro error (por ejemplo formato o esquema), arrojar
        throw err;
      }
    }

    throw new Error(
      `[Gemini Rotator] Se agotaron los reintentos (${maxAttempts}) probando todas las claves disponibles para '${operationName}'.`
    );
  }
}

// Instancia singleton para toda la aplicación
export const geminiRotator = new GeminiKeyRotator();

